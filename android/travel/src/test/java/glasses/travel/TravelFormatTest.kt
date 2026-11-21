package glasses.travel

import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** The GET /travel wire contract, time formatting in airport zones, provider errors and the list rows (docs/spec.md). */
class TravelFormatTest {
    private val epoch = Instant.parse("2030-01-15T15:00:00Z").toEpochMilli()
    private val fallback = ZoneId.of("UTC") // device zone, used only when an airport has no tz

    /** A GET /travel body as the gateway writes it: nulls, a numeric gate, a fractional delay and one broken flight. */
    private val wire = TravelFormat.json.parseToJsonElement("""
        {"flights":[
          {"id":"f1","ident":"XX123","label":null,"date":"2030-01-15","airline":{"iata":"XX","name":"Example Air"},"number":123,
           "origin":{"code":"MSP","city":"Minneapolis","name":"Minneapolis-St Paul Intl","tz":"America/Chicago"},
           "destination":{"code":"ORD","city":"Chicago","name":null,"tz":"America/Chicago"},
           "status":"delayed","statusText":"Delayed 25 min",
           "departure":{"scheduled":"2030-01-15T16:50:00Z","estimated":"2030-01-15T17:15:00Z","actual":null,"delayMin":25.0,"gate":7,"terminal":"A",
             "boarding":{"time":"2030-01-15T16:40:00Z","scheduledTime":"2030-01-15T16:15:00Z","leadMin":35.0,"estimated":true}},
           "arrival":{"scheduled":"2030-01-15T17:55:00Z","estimated":"2030-01-15T18:20:00Z","actual":null,"delayMin":25,"gate":"12","terminal":null,"baggage":null},
           "progress":null,"inbound":{"ident":"XX987","status":"en_route","delayMin":30},"polledAt":"2030-01-15T14:57:00Z","nextPollAt":null,"error":null},
          {"id":"f2","ident":"XX456","date":"2030-01-15","origin":{"code":"ORD","tz":"America/Chicago"},"destination":{"code":"DEN","tz":"America/Denver"},
           "status":"en_route","statusText":"En route, lands 3:42 PM",
           "departure":{"scheduled":"2030-01-15T19:00:00Z","actual":"2030-01-15T19:04:00Z","delayMin":4,"gate":"4"},
           "arrival":{"scheduled":"2030-01-15T20:55:00Z","estimated":"2030-01-15T20:50:00Z","delayMin":-5,"gate":"B32","baggage":"5"}},
          {"ident":"BROKEN"},
          {"id":"f3","ident":"XX789","date":"2030-01-16","origin":{"code":"DEN"},"destination":{"code":"MSP"},"status":"scheduled","statusText":"","error":"no_provider",
           "departure":{"scheduled":"2030-01-16T13:00:00Z","delayMin":0},"arrival":{"scheduled":"2030-01-16T15:45:00Z","delayMin":0}}
        ],
        "connections":[{"fromId":"f1","toId":"f2","airport":"ORD","layoverMin":40,"minConnectMin":35,"status":"tight","text":"40 min in ORD, gate 12 -> 4"}],
        "settings":{"notify":{"delays":true,"gates":false,"connection":true,"departures":true,"arrivals":false},"delayThresholdMin":20,"minConnectMin":45,"popupWindowH":3,"boardingLeadMin":null},
        "provider":{"name":"aeroapi","configured":true},"updatedAt":"2030-01-15T14:58:00Z"}
    """.trimIndent())

    @Test fun parsesTheGatewaySnapshotAndSkipsOnlyTheBrokenFlight() {
        val s = TravelFormat.snapshot(wire)
        assertEquals(listOf("f1", "f2", "f3"), s.flights.map { it.id })
        val f = s.flights[0]
        assertEquals("7", f.departure.gate)
        assertEquals("123", f.number)
        assertEquals(25, f.departure.delayMin)
        assertNull(f.label)
        assertEquals("America/Chicago", f.origin.tz)
        assertEquals(TravelInbound("XX987", "en_route", 30), f.inbound)
        assertEquals(TravelBoarding("2030-01-15T16:40:00Z", "2030-01-15T16:15:00Z", 35, true), f.departure.boarding)
        assertNull(s.flights[1].departure.boarding)
        assertEquals(-5, s.flights[1].arrival.delayMin)
        assertEquals("5", s.flights[1].arrival.baggage)
        assertEquals(TravelSettings(TravelNotify(true, false, true, true, false), 20, 45, 3.0), s.settings)
        assertTrue(s.provider.configured)
        assertEquals("tight", s.connections.single().status)
        assertEquals(TravelSnapshot(), TravelFormat.snapshot(JsonPrimitive("nope")))
    }

    @Test fun formatsTimesInTheAirportZoneAndExplainsProviderErrors() {
        val s = TravelFormat.snapshot(wire)
        val f = s.flights[0]
        assertEquals("11:15 AM", TravelFormat.clock(f.departure.best, f.origin, ZoneId.of("UTC")))
        // DEN is on Mountain time: the same instant reads an hour earlier than at the Central-time origin.
        assertEquals("1:50 PM", TravelFormat.clock(s.flights[1].arrival.best, s.flights[1].destination, fallback))
        assertEquals("--", TravelFormat.clock(null, f.origin, fallback))
        assertEquals("No flight data provider set up", TravelFormat.statusLine(s.flights[2]))
        assertEquals("Gate 7 · Term A", TravelFormat.gate(f.departure))
        assertEquals("3m ago", TravelFormat.ago(f.polledAt, epoch))
        assertEquals("Add the airline code, e.g. UA 123 (United is UA)", TravelFormat.failure(400, """{"error":"airline_required"}"""))
        assertEquals("Gateway error (500)", TravelFormat.failure(500, ""))
        assertEquals("Date must be YYYY-MM-DD, within a year of today", TravelFormat.failure(400, """{"error":"invalid_date"}"""))
        assertEquals("1.5", TravelFormat.hours(1.5)); assertEquals("0", TravelFormat.hours(0.0))
        val overnight = f.copy(arrival = f.arrival.copy(estimated = "2030-01-16T06:30:00Z"))
        assertEquals("+1", TravelFormat.dayShift(overnight, fallback))
    }

    @Test fun listRowsPutEachConnectionAfterItsFlightAndShowTheTimeThatMattersNext() {
        val rows = TravelFormat.rows(TravelFormat.snapshot(wire), LocalDate.of(2030, 1, 15), fallback)
        assertEquals(listOf("F", "C", "F", "F"), rows.map { if (it is TravelFormat.FlightRow) "F" else "C" })
        val first = rows[0] as TravelFormat.FlightRow
        assertEquals("XX123 MSP→ORD", first.title)
        assertEquals("11:15 AM", first.time) // estimated departure, origin zone
        assertEquals("Dep", first.end); assertEquals("7", first.gate)
        assertEquals("~10:40 AM", first.boards) // estimated boarding, always marked "~"
        assertEquals("~10:15 AM", TravelFormat.boardsScheduled(first.flight, fallback))
        assertFalse(first.boardingNow)
        val boarding = TravelFormat.rows(TravelFormat.snapshot(wire).let { s -> s.copy(flights = s.flights.map { if (it.id == "f1") it.copy(status = "boarding") else it }) },
            LocalDate.of(2030, 1, 15), fallback)[0] as TravelFormat.FlightRow
        assertTrue(boarding.boardingNow); assertEquals("Boarding now", boarding.status)
        assertEquals("Delayed 25 min", first.status)
        assertTrue(first.alarm)
        val connection = rows[1] as TravelFormat.ConnectionRow
        assertEquals("40 min in ORD, gate 12 -> 4", connection.text)
        assertEquals("Tight", connection.word)
        assertTrue(connection.alarm)
        // In the air: the arrival time (Denver local) and gate; tomorrow's flight says so.
        val second = rows[2] as TravelFormat.FlightRow
        assertEquals("1:50 PM", second.time)
        assertEquals("Arr", second.end); assertEquals("B32", second.gate)
        assertNull(second.boards) // in the air: no boarding time
        assertNull((rows[3] as TravelFormat.FlightRow).gate)
        assertFalse(second.alarm)
        assertEquals("Tomorrow · No flight data provider set up", (rows[3] as TravelFormat.FlightRow).status)
        val ok = TravelFormat.rows(TravelFormat.snapshot(wire).let { s -> s.copy(connections = s.connections.map { it.copy(status = "ok", text = "") }) },
            LocalDate.of(2030, 1, 15), fallback)[1] as TravelFormat.ConnectionRow
        assertEquals("40 min in ORD", ok.text); assertFalse(ok.alarm)
    }

    @Test fun relativeDaysAndAges() {
        val today = LocalDate.of(2030, 1, 15)
        assertEquals("Today", TravelFormat.dayName(today, today))
        assertEquals("Tomorrow", TravelFormat.dayName(today.plusDays(1), today))
        assertEquals("Yesterday", TravelFormat.dayName(today.minusDays(1), today))
        assertEquals("Fri", TravelFormat.dayName(today.plusDays(3), today))
        assertEquals("Feb 1", TravelFormat.dayName(LocalDate.of(2030, 2, 1), today))
        assertEquals("now", TravelFormat.age(59)); assertEquals("2h", TravelFormat.age(7200)); assertEquals("", TravelFormat.ago(null, epoch))
    }
}
