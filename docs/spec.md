# Travel (flight tracking): specification

The wearer adds flights (from the phone, or an agent does it through the host's tools). The gateway polls
flight status, works out connections, and writes notifications for the glasses when something changes. The
glasses get a Travel app (flight list and flight detail); the phone gets a Travel page (flights and settings).

This repository holds the gateway engine (`server/`) and the Android data layer (`android/travel`). The host
owns its router, document store, event bus, secret store, screens and phone page.

## Data source

FlightAware AeroAPI v4, `GET https://aeroapi.flightaware.com/aeroapi/flights/{ident}?start=&end=` with
header `x-apikey`. The key is the secret `FLIGHTAWARE_AEROAPI_KEY`, read with
`ctx.secret('FLIGHTAWARE_AEROAPI_KEY', {optional:true})`; where the host stores it is up to the host. Without a
key the API still adds and lists flights, every flight shows `error: "no_provider"`, and
`provider.configured` is false. AeroAPI is billed per call, so the poller is adaptive (below) and never polls
a flight that has arrived.

Relevant AeroAPI fields per flight: `ident`, `ident_iata`, `fa_flight_id`, `operator_iata`, `flight_number`,
`origin`/`destination` `{code_iata, code_icao, name, city, timezone}`, `status` (free text),
`departure_delay`/`arrival_delay` (seconds), `scheduled_out|estimated_out|actual_out` (gate departure),
`scheduled_off|estimated_off|actual_off` (takeoff), `scheduled_on|estimated_on|actual_on` (landing),
`scheduled_in|estimated_in|actual_in` (gate arrival), `gate_origin`, `gate_destination`,
`terminal_origin`, `terminal_destination`, `baggage_claim`, `cancelled`, `diverted`, `progress_percent`,
`inbound_fa_flight_id`. The engine picks the flight whose `scheduled_out` falls on the requested local date
(origin time zone); with several same-day legs, the earliest one that has not arrived, then it keeps that
leg's `fa_flight_id`. The inbound aircraft (`GET /flights/{inbound_fa_flight_id}`) gives an early delay
warning: it is fetched only inside 6 h of departure, at most every 20 min, and never again once it has landed.
AeroAPI answers at most two days ahead and ten days back; nothing is fetched outside that window.

## Gateway API

Paths are relative to wherever the host mounts them; the host decides authentication and scopes.

- `GET /travel` -> `{ flights: Flight[], connections: Connection[], settings: Settings, provider: {name:"aeroapi", configured:boolean}, updatedAt }`
  Flights sorted by scheduled departure; flights more than 12 h past arrival leave the list (kept in the
  store for 3 days, then deleted).
- `POST /travel/flights {ident, date?, label?}` -> `Flight`. `ident` accepts `UA123`, `UA 123`, `UAL123`
  (ICAO works too, AeroAPI takes both); a bare number is rejected with 400 `airline_required`. `date` is
  `YYYY-MM-DD` (the departure's local date) and defaults to today in the home zone (`ctx.config.tz`, default
  `UTC`). The same ident and date returns the existing flight. Adding polls once at once (best effort, 8 s budget).
- `DELETE /travel/flights/:id` -> `{ok:true}`
- `POST /travel/refresh` -> as `GET /travel`, after polling every active flight now.
- `GET /travel/settings`, `PUT /travel/settings` (partial merge, validated, else 400 `invalid_settings`) -> `Settings`.

Errors are thrown with an HTTP `status` and a machine-readable `message` (`ident_required`,
`airline_required`, `invalid_ident`, `invalid_date`, `invalid_label`, `invalid_settings`); hosts answer
`{error: message}`. Every change publishes a `travel` event (with `supersede: true`) so clients refresh.

```
Flight = {
  id, ident, label|null, date,                 // id = ident-date; ident upper-case, no space
  airline: {iata|null, name|null}, number,
  origin: Airport, destination: Airport,        // Airport = {code, city|null, name|null, tz|null}
  status: "scheduled"|"delayed"|"boarding"|"departed"|"en_route"|"landed"|"arrived"|"cancelled"|"diverted"|"unknown",
  statusText,                                    // short line, e.g. "Delayed 25 min, departs 11:50 AM", "En route, lands 3:42 PM";
                                                 // within 3 h of departure: "Boards 10:45 AM, gate 7" / "Delayed 25 min, boards 11:10 AM"
  departure: Times & {gate|null, terminal|null,  // Times = {scheduled, estimated|null, actual|null, delayMin}
    boarding: {time, scheduledTime, leadMin, estimated:true}|null},
  arrival:   Times & {gate|null, terminal|null, baggage|null},
  progress|null, inbound: {ident, status, delayMin}|null,
  polledAt|null, nextPollAt|null, error|null     // error: "no_provider"|"not_found"|"provider_error"
}
Connection = { fromId, toId, airport, layoverMin, minConnectMin, status: "ok"|"tight"|"at_risk"|"missed", text }
Settings = {
  notify: { delays: true, gates: true, connection: true, departures: true, arrivals: true },
  delayThresholdMin: 15,     // 1..240, smallest delay change that notifies
  minConnectMin: 35,         // 0..240, minimum safe connection
  popupWindowH: 4,           // 0..48 (fractions allowed), popups only within this many hours of departure (or during it)
  boardingLeadMin: null      // 10..90, or null = airline default (WN 35, UA 35, AA/DL/B6/AS/NK/F9 40, else 40)
}
```

Times are ISO-8601 UTC strings; clients format them in the airport's `tz` (fallback: the device zone).
AeroAPI has no boarding time, so the engine estimates it: `departure.boarding.time` = gate departure
(`estimated` ?? `scheduled`) minus `leadMin`, `scheduledTime` = `scheduled` minus `leadMin`, where `leadMin` is
`boardingLeadMin` or the airline default; `boarding` is null without a departure time or when
cancelled/diverted. Status `boarding` = now >= the boarding time and not departed. Boarding times are always
estimates; clients mark them `~`.

### Connections

Two tracked flights connect when B's origin equals A's destination and B is scheduled to leave 0-24 h after
A's scheduled arrival. Layover = B departure (actual, else estimated, else scheduled) minus A gate arrival
(actual, else estimated, else scheduled). `ok` >= minConnect + 15, `tight` >= minConnect, `at_risk` >= 0,
`missed` < 0 or B left before A arrived. `text` e.g. "52 min in ORD, gate 12 -> 4". A connection only recovers
once its layover is 5 min past the boundary it crossed (hysteresis), so a flapping estimate pops up once.

## Poller

Run it in one process only (the host decides which). It ticks every 60 s (`ctx.config.travelTickMs`) and
polls a flight when its `nextPollAt` has passed: more than 24 h before departure every 3 h; 6-24 h every
30 min; inside 6 h through landing every 5 min; landed without a gate arrival every 5 min for an hour, then
30 min, giving up 2 h after touchdown; after gate arrival one last poll, then stop. Cancelled/diverted
flights keep 15 min polls until 6 h after scheduled arrival. Provider errors (429/5xx, timeouts) back off,
doubling the interval up to 1 h, and keep the last good data.

## Notifications

Each new snapshot is diffed against the last notified state, and changes are written as one notification
(`ctx.store.put('notifications', n)` then `ctx.events.publish('notification', n)`) with `source:"Travel"`,
`icon:"plane"`, `open:{screen:"travel", flightId, args:{flightId}}`, `route:"popup"|"stream"` and
`importance` 0.9 (popup) or 0.5 (stream). The rubric: pop up only what matters within the hour, one popup
per burst.

| Change | Route |
| --- | --- |
| Cancelled, diverted | popup, always (names affected connections) |
| Delay grows or shrinks by >= threshold | popup inside popupWindowH, else stream. Inside the window the body adds "Boards ~10:45 AM" |
| Gate or terminal change | popup inside popupWindowH, else stream |
| Connection becomes tight / at_risk / missed (worse than before) | popup inside the earlier flight's window (a first-seen tight connection streams); the same worsening does not pop up again within 30 min |
| Connection recovers | stream |
| Boarding (first time, at the estimated boarding time) | popup, body leads with the gate: "Boarding now at gate 7. Departs 11:25 AM." |
| Departed / landed / arrived (with baggage claim and the onward connection's gate when known) | stream |
| Smaller changes | nothing |

The popup window opens at the earlier of the scheduled and current departure, so a long delay cannot hide
it. A flight's first data is compared with an unremarkable baseline (on time, connection ok), so a flight
that is already cancelled, delayed or badly connected is announced at once. Changes found in one poll merge
into one notification (title = the most important change, body lists the rest), e.g. title
`XX123 delayed 40 min`, body `Delayed 40 min. Departs 12:05 PM from gate 7. Connection in ORD now 22 min (at risk).`
The last notified state is stored per flight and per connection, so a restart never repeats a notification.

## Android library (`glasses.travel`)

`TravelFlight`, `TravelConnection`, `TravelSettings`, `TravelSnapshot` and friends mirror the JSON above
(`@Serializable`, lenient). `TravelFormat` decodes the wire (numeric gates stay strings, fractional minutes
round, one malformed flight is skipped rather than the whole list), maps failures to short messages, formats
clocks in airport zones, and builds the glasses list rows: each flight shows the time that matters next
(departure before take-off, arrival with a `+1` day shift after) and its gate, followed by its outgoing
connection. Screens, the phone page, storage and transport stay in the host.

## Host surfaces (reference design)

- Glasses: a Travel app. The list shows each flight (ident + route, status line, big departure/arrival time,
  gate, estimated boarding), with connection rows between flights; selecting opens a detail screen (all
  times scheduled vs estimated, gates, terminals, baggage, inbound aircraft, last update); a refresh key
  calls `POST /travel/refresh`. Opening a `screen:"travel"` notification with `flightId` lands on that
  flight's detail.
- Phone: a Travel page with the flight list (remove), "Add flight" (ident + date + label), Refresh, and the
  settings above, saved through `PUT /travel/settings`.
- Agent tools (optional): add, list and remove flights and read/write settings by calling the engine
  directly, so they work while the phone is offline. Tell agents that an airline code is required and that
  dates are the departure's local date.
