# Fireplace

A lit fireplace heats rooms the HVAC is also trying to manage. Tell HomeClimate when a fire is lit and which rooms it warms, and it can keep those rooms out of the heating and cooling's way. **HomeClimate never turns a fireplace on or off.**

Find it under **Smart Control → Fireplace**. Fireplaces are added here rather than in My Home because most rooms don't have one.

## Adding a fireplace

- **Name** — up to 60 characters.
- **On While the Fire Is Lit** — any switch, binary sensor, input boolean, light, fan or climate entity that is on while the fire burns, such as the relay that runs a gas fireplace. A climate entity counts as lit while it reports it is heating.
- **Rooms It Warms** — every room the fire heats, not only the room it is in. A room above the fireplace often warms as much as the room around it.

## Settings per fireplace

| Setting | Default | What it does |
|---|---|---|
| **Fireplace Compensation** | On | On sets its rooms aside while it is lit or cooling down. Off ignores the fireplace. A fireplace that was on Watch Only before 0.5.25 is Off. To see what it would do first, use Dev Mode. |
| **Cool-Down After It Goes Out** | 60 min | How long the rooms stay set aside after the fire goes out, while the room is still warm. 0 to 240 minutes. |

## What "set aside" means

While a fireplace set to **On** is lit, and through its cool-down, the rooms it warms stop calling for heating or cooling, the same way a room does when its door or window is open:

- the fire's heat can't satisfy the thermostat for rooms that are still cold, because the warm room isn't counted;
- a room made hot by the fire can't call for cooling, so the air conditioning doesn't run against the fire. This holds even past the maximum safety temperature: the too-warm safety limit is not applied to a room a fire is warming, nor to the thermostat of a zone with such a room. Vacation Mode follows the same rule: while a fire is warming a zone, its hold turns the equipment off above the maximum instead of cooling, rests in heat rather than cool in between, and does not hand the thermostat a heat-and-cool range.

The too-cold safety limit still applies: a set-aside room that falls below its minimum safety temperature is heated regardless. The Dashboard marks each set-aside room with a **Fireplace** badge.

Changing a fireplace's rule, rooms or signal, or removing it, takes effect straight away.

## When the signal misbehaves

- **It stops reporting while the fire is lit** (a relay drops off the network): nobody saw the fire go out, so HomeClimate treats it as still lit for up to 3 hours, or the cool-down if that is longer, then hands the rooms back. The section shows **Signal Lost While Lit** and the log records it.
- **It stops reporting when the fire was not lit**: shown as **Not Reporting**; nothing is set aside.
- **It is left on**: the rooms stay set aside until it turns off. After 12 hours of reading as lit, a warning is logged asking you to check it. The too-cold safety limit above is the backstop.
- **Home Assistant is disconnected or restarting**: nothing is concluded. A fire that was lit is treated as still lit, for up to 3 hours, and a cool-down already under way keeps running, including across a HomeClimate restart. Just after Home Assistant comes back, a signal that hasn't reported yet can briefly show as Not Reporting or Signal Lost.

A burner that cycles on and off during one fire is logged as one fire, not one line per cycle.

## Records

- The Logs page (category `fireplace`) records each fire being lit, going out, and finishing its cool-down.
- Smart Learning readings note when a room's fireplace is warm, for fireplaces with Fireplace Compensation on, so those hours can be left out of what is learned about the room.

## API

- `GET /api/fireplaces` — each fireplace with its state (`lit`, `cooling`, `out`, `unknown`).
- `POST /api/fireplaces`, `PUT /api/fireplaces/{id}`, `DELETE /api/fireplaces/{id}`.
- `GET /api/smart-control` includes `fireplace_rooms`, the rooms set aside right now.
