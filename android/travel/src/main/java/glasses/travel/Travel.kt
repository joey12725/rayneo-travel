package glasses.travel

import java.time.*
import java.time.format.DateTimeFormatter
import java.time.temporal.ChronoUnit
import java.util.Locale
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.*

// Travel (flight tracking, docs/spec.md): the gateway's GET /travel contract, decoded once per snapshot.

@Serializable data class TravelAirport(val code: String = "", val city: String? = null, val name: String? = null, val tz: String? = null)
@Serializable data class TravelAirline(val iata: String? = null, val name: String? = null)

/**
 * Estimated boarding (departure only): the departure time minus an airline-typical lead. Always an estimate, so the
 * screens label it "~". [time] follows the current departure estimate; [scheduledTime] the schedule.
 */
@Serializable
data class TravelBoarding(
    val time: String? = null,
    val scheduledTime: String? = null,
    val leadMin: Int? = null,
    val estimated: Boolean = true,
)

/** One end of a flight: ISO-8601 UTC times plus the gate, terminal, boarding (departure) and baggage claim (arrival). */
@Serializable
data class TravelTimes(
    val scheduled: String? = null,
    val estimated: String? = null,
    val actual: String? = null,
    val delayMin: Int = 0,
    val gate: String? = null,
    val terminal: String? = null,
    val baggage: String? = null,
    val boarding: TravelBoarding? = null,
) {
    /** Actual, else estimated, else scheduled (the gateway's own rule for layovers). */
    val best get() = actual ?: estimated ?: scheduled
}

@Serializable data class TravelInbound(val ident: String = "", val status: String = "", val delayMin: Int = 0)

@Serializable
data class TravelFlight(
    val id: String,
    val ident: String = "",
    val label: String? = null,
    val date: String = "",
    val airline: TravelAirline = TravelAirline(),
    val number: String = "",
    val origin: TravelAirport = TravelAirport(),
    val destination: TravelAirport = TravelAirport(),
    val status: String = "unknown",
    val statusText: String = "",
    val departure: TravelTimes = TravelTimes(),
    val arrival: TravelTimes = TravelTimes(),
    val progress: Double? = null,
    val inbound: TravelInbound? = null,
    val polledAt: String? = null,
    val nextPollAt: String? = null,
    val error: String? = null,
)

@Serializable
data class TravelConnection(
    val fromId: String = "",
    val toId: String = "",
    val airport: String = "",
    val layoverMin: Int = 0,
    val minConnectMin: Int = 35,
    val status: String = "ok",
    val text: String = "",
)

@Serializable
data class TravelNotify(
    val delays: Boolean = true,
    val gates: Boolean = true,
    val connection: Boolean = true,
    val departures: Boolean = true,
    val arrivals: Boolean = true,
)

@Serializable
data class TravelSettings(
    val notify: TravelNotify = TravelNotify(),
    val delayThresholdMin: Int = 15,
    val minConnectMin: Int = 35,
    /** Hours; the gateway accepts fractions (0..48, 0 = no pop-ups). */
    val popupWindowH: Double = 4.0,
    /** Minutes before departure that boarding starts (10..90); null = the airline's typical lead. */
    val boardingLeadMin: Int? = null,
)

@Serializable data class TravelProvider(val name: String = "aeroapi", val configured: Boolean = false)

@Serializable
data class TravelSnapshot(
    val flights: List<TravelFlight> = emptyList(),
    val connections: List<TravelConnection> = emptyList(),
    val settings: TravelSettings = TravelSettings(),
    val provider: TravelProvider = TravelProvider(),
    val updatedAt: String? = null,
)

/** Wire adaptation and display formatting for Travel. Pure functions, so the screens and tests share them. */
object TravelFormat {
    /** Lenient decoding shared with hosts: unknown keys are ignored, nulls fall back to defaults. */
    val json = Json { isLenient = true; ignoreUnknownKeys = true; coerceInputValues = true; encodeDefaults = true }
    private fun JsonElement.s(key: String) = (this as? JsonObject)?.get(key)?.let { (it as? JsonPrimitive)?.contentOrNull } ?: ""
    private fun JsonElement.a(key: String) = (this as? JsonObject)?.get(key) as? JsonArray ?: JsonArray(emptyList())
    private val INT_KEYS = setOf("delayMin", "layoverMin", "minConnectMin", "delayThresholdMin", "leadMin", "boardingLeadMin")
    private val STRING_KEYS = setOf("number", "gate", "terminal", "baggage", "ident", "code", "id", "fromId", "toId", "airport", "date")
    private val CLOCK = DateTimeFormatter.ofPattern("h:mm a", Locale.US)
    private val DAY = DateTimeFormatter.ofPattern("EEE MMM d", Locale.US)
    val AFTER_DEPARTURE = setOf("departed", "en_route", "landed", "arrived", "diverted")

    /** Numbers the gateway may send as 25.0 become whole minutes; numeric gates ("7") stay strings. */
    private fun clean(value: JsonElement): JsonElement = when (value) {
        is JsonArray -> JsonArray(value.map(::clean))
        is JsonObject -> JsonObject(value.filterValues { it != JsonNull }.mapValues { (key, v) ->
            when {
                key in INT_KEYS && v is JsonPrimitive && !v.isString -> v.doubleOrNull?.let { JsonPrimitive(Math.round(it)) } ?: v
                key in STRING_KEYS && v is JsonPrimitive && !v.isString -> JsonPrimitive(v.content)
                else -> clean(v)
            }
        })
        else -> value
    }

    fun flight(value: JsonElement): TravelFlight = json.decodeFromJsonElement(clean(value))
    fun settings(value: JsonElement): TravelSettings = json.decodeFromJsonElement(clean(value))

    /** GET /travel (and POST /travel/refresh). One malformed flight or connection is skipped, not the whole list. */
    fun snapshot(value: JsonElement): TravelSnapshot {
        val o = value as? JsonObject ?: return TravelSnapshot()
        val flights = o.a("flights").mapNotNull { runCatching { flight(it) }.getOrNull() }
        val connections = o.a("connections").mapNotNull { runCatching { json.decodeFromJsonElement<TravelConnection>(clean(it)) }.getOrNull() }
        return TravelSnapshot(
            flights, connections,
            o["settings"]?.let { runCatching { settings(it) }.getOrNull() } ?: TravelSettings(),
            o["provider"]?.let { runCatching { json.decodeFromJsonElement<TravelProvider>(clean(it)) }.getOrNull() } ?: TravelProvider(),
            o.s("updatedAt").ifBlank { null },
        )
    }

    /** The message for a failed travel write (the gateway answers `{error}`): airline_required gets a usable hint. */
    fun failure(code: Int, body: String): String {
        val error = runCatching { json.parseToJsonElement(body.ifBlank { "{}" }).s("error") }.getOrDefault("").trim()
        return when {
            error == "airline_required" -> "Add the airline code, e.g. UA 123 (United is UA)"
            error.contains("date", ignoreCase = true) -> "Date must be YYYY-MM-DD, within a year of today"
            code == 401 || code == 403 -> "Check token"
            code == 404 && error.isBlank() -> "Travel is not on this gateway yet"
            error.isNotBlank() -> error.replace('_', ' ').replaceFirstChar { it.uppercase() }.let { if (it.length > 80) it.take(79) + "…" else it }
            else -> "Gateway error ($code)"
        }
    }

    fun zone(airport: TravelAirport, fallback: ZoneId): ZoneId =
        airport.tz?.let { runCatching { ZoneId.of(it) }.getOrNull() } ?: fallback

    fun instant(iso: String?): Instant? = iso?.let { runCatching { Instant.parse(it) }.getOrNull() }

    /** "11:25 AM" in the airport's time zone, or "--" when unknown. */
    fun clock(iso: String?, airport: TravelAirport, fallback: ZoneId): String =
        instant(iso)?.atZone(zone(airport, fallback))?.format(CLOCK) ?: "--"

    /** "+1" when the arrival's local date is after the departure's local date. */
    fun dayShift(f: TravelFlight, fallback: ZoneId): String {
        val dep = instant(f.departure.best)?.atZone(zone(f.origin, fallback))?.toLocalDate() ?: return ""
        val arr = instant(f.arrival.best)?.atZone(zone(f.destination, fallback))?.toLocalDate() ?: return ""
        val days = ChronoUnit.DAYS.between(dep, arr)
        return if (days > 0) "+$days" else if (days < 0) "$days" else ""
    }

    fun departed(f: TravelFlight) = f.status in AFTER_DEPARTURE

    /** The route as the glasses show it: "MSP→ORD". */
    fun route(f: TravelFlight) = "${f.origin.code.ifBlank { "?" }}→${f.destination.code.ifBlank { "?" }}"

    /** The status line: the gateway's statusText, else words for the status or the provider error. */
    fun statusLine(f: TravelFlight): String = when (f.error) {
        "no_provider" -> "No flight data provider set up"
        "not_found" -> "Flight not found for ${f.date.ifBlank { "that date" }}"
        "provider_error" -> f.statusText.ifBlank { "Status unavailable, will retry" }
        else -> f.statusText.ifBlank {
            when (f.status) {
                "scheduled" -> "Scheduled"; "delayed" -> if (f.departure.delayMin > 0) "Delayed ${f.departure.delayMin} min" else "Delayed"
                "boarding" -> "Boarding"; "departed" -> "Departed"; "en_route" -> "En route"; "landed" -> "Landed"
                "arrived" -> "Arrived"; "cancelled" -> "Cancelled"; "diverted" -> "Diverted"; else -> "Waiting for status"
            }
        }
    }

    /** A status that needs attention (drawn at full brightness). */
    fun alarming(f: TravelFlight) = f.status in setOf("delayed", "cancelled", "diverted", "boarding") || f.error != null

    /** "Today", "Tomorrow", a weekday this week, else "Nov 26" for the flight's departure date. */
    fun day(f: TravelFlight, today: LocalDate): String =
        runCatching { LocalDate.parse(f.date) }.getOrNull()?.let { dayName(it, today) } ?: ""

    fun dayLong(f: TravelFlight): String = runCatching { LocalDate.parse(f.date).format(DAY) }.getOrDefault(f.date)

    /** Gate (and terminal) for one end: "Gate 7 · T A", "Gate 7", "T 2", or "" when nothing is known. */
    fun gate(t: TravelTimes): String = listOfNotNull(t.gate?.takeIf { it.isNotBlank() }?.let { "Gate $it" },
        t.terminal?.takeIf { it.isNotBlank() }?.let { "Term $it" }).joinToString(" · ")

    fun connectionWord(status: String) = when (status) {
        "ok" -> "OK"; "tight" -> "Tight"; "at_risk" -> "At risk"; "missed" -> "Missed"; else -> status.replace('_', ' ')
    }

    /** Server limits (server/travel.mjs LIMITS): whole minutes 1..240 and 0..240; hours 0..48, fractions allowed. */
    val DELAY_THRESHOLD_RANGE = 1..240
    val MIN_CONNECT_RANGE = 0..240
    val POPUP_WINDOW_RANGE = 0.0..48.0
    val BOARDING_LEAD_RANGE = 10..90

    /** "~8:05 PM": estimated boarding for a flight that has not left; null when unknown or already departed. */
    fun boards(f: TravelFlight, fallback: ZoneId): String? {
        if (departed(f) || f.status == "cancelled") return null
        val b = f.departure.boarding ?: return null
        val at = b.time ?: b.scheduledTime ?: return null
        return "~" + clock(at, f.origin, fallback)
    }

    /** "~7:35 PM" when the scheduled boarding differs from the current estimate, else null. */
    fun boardsScheduled(f: TravelFlight, fallback: ZoneId): String? {
        val b = f.departure.boarding ?: return null
        val sched = b.scheduledTime ?: return null
        if (b.time == null || b.time == sched) return null
        return "~" + clock(sched, f.origin, fallback)
    }

    fun boardingNow(f: TravelFlight) = f.status == "boarding"

    /** "4" for whole hours, "1.5" otherwise. */
    fun hours(h: Double): String = if (h == Math.floor(h)) h.toLong().toString() else h.toString()

    /** A day relative to today: Today, Tomorrow, Yesterday, a weekday within the week, else Nov 26. */
    fun dayName(date: LocalDate, today: LocalDate): String = when (val days = ChronoUnit.DAYS.between(today, date)) {
        0L -> "Today"
        1L -> "Tomorrow"
        -1L -> "Yesterday"
        else -> date.format(DateTimeFormatter.ofPattern(if (days in 2..6) "EEE" else "MMM d", Locale.US))
    }

    /** "now", "4m", "2h", "3d", "2w" for an age in seconds. */
    fun age(seconds: Long): String = when {
        seconds < 60 -> "now"
        seconds < 3600 -> "${seconds / 60}m"
        seconds < 86400 -> "${seconds / 3600}h"
        seconds < 86400 * 10 -> "${seconds / 86400}d"
        else -> "${seconds / (86400 * 7)}w"
    }

    /** "now", "4m ago", "2h ago" since [iso]; "" when unknown. */
    fun ago(iso: String?, nowMs: Long): String {
        val at = instant(iso) ?: return ""
        val s = ((nowMs - at.toEpochMilli()) / 1000).coerceAtLeast(0)
        return if (s < 60) "now" else age(s) + " ago"
    }

    /** One line of the glasses list: a flight, or the connection between two flights. */
    sealed interface Row
    data class FlightRow(
        val flight: TravelFlight,
        /** "XX123 MSP→ORD". */
        val title: String,
        /** Status line, prefixed by the day when it is not today ("Tomorrow · On time"). */
        val status: String,
        /** The big time: departure before take-off, arrival after. */
        val time: String,
        /** "Dep" or "Arr": which end [time] and [gate] belong to. */
        val end: String,
        /** The gate at that end, or null when not posted. */
        val gate: String?,
        /** "~8:05 PM" estimated boarding (before departure only). */
        val boards: String?,
        /** Status is boarding: the row says "Boarding now", highlighted. */
        val boardingNow: Boolean,
        val alarm: Boolean,
    ) : Row
    data class ConnectionRow(val connection: TravelConnection, val text: String, val word: String, val alarm: Boolean) : Row

    /** List rows: flights in the gateway's order, each connection right after the flight it leaves from. */
    fun rows(s: TravelSnapshot, today: LocalDate, fallback: ZoneId): List<Row> = s.flights.flatMap { f ->
        val after = departed(f)
        val end = if (after) f.arrival else f.departure
        val airport = if (after) f.destination else f.origin
        val time = clock(end.best, airport, fallback).let { if (after && it != "--") it + dayShift(f, fallback) else it }
        val day = day(f, today).takeIf { it.isNotBlank() && it != "Today" }
        val now = boardingNow(f)
        val row = FlightRow(f, "${f.ident} ${route(f)}", listOfNotNull(day, if (now) "Boarding now" else statusLine(f)).joinToString(" · "), time,
            if (after) "Arr" else "Dep", end.gate?.takeIf { it.isNotBlank() }, boards(f, fallback), now, alarming(f))
        listOf(row) + s.connections.filter { it.fromId == f.id }.map { c ->
            val text = c.text.ifBlank { "${c.layoverMin} min in ${c.airport}" }
            ConnectionRow(c, text, connectionWord(c.status), c.status != "ok")
        }
    }
}
