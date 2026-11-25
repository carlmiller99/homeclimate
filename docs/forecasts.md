# Forecasts

HomeClimate can fetch the hourly weather forecast from Home Assistant, keep using it through outages, and archive it. This is the groundwork for forecast-aware control. Its one use in control so far is [building mode](./building-mode.md): with a building's Auto set to On, the forecast can stop a switch between heating and cooling. Everything else about the forecast is shown and recorded only.

Find it under **Smart Control → Forecasts**.

## Settings

| Setting | Default | What it does |
|---|---|---|
| **Use the Weather Forecast** | Off | Fetches the hourly forecast every 30 minutes. |
| **Weather Source** | Not set | A Home Assistant weather entity that provides an hourly forecast (the National Weather Service integration does). If none is set here, the one set for Shades is used. |

## What you see

- A status line: up to date, showing the last forecast received (when the latest fetch failed, with the reason shown, or the forecast is more than 90 minutes old), or no forecast yet.
- The high and low for each date the forecast covers, in the house's time zone. "Today" covers only the hours still to come.
- The next 24 hours: temperature, sky, cloud cover and chance of rain. A dash means the weather source did not say.
- **Fetch Now** asks for a fresh forecast straight away.

## Outages

If a fetch fails, the last good forecast keeps being used for the hours it still covers, and it survives a restart. A reply that covers fewer hours than the last one replaces only the hours it covers. Changing the weather source discards the old source's forecast once the new one answers, and never shows one source's hours as another's. The Logs page (category `forecast`) records when fetching starts failing and when it recovers, not every attempt.

## Storage

- `forecast_hours` holds the forecast in use: one row per hour, replaced on each fetch. Hours more than two days past are dropped.
- `forecast_snapshots` archives what was forecast for the next 72 hours, once per clock hour, so forecasts can later be scored against what happened. It is kept for 90 days, about 2 to 3 MB at most.

Temperatures are converted to °F when stored, using the weather entity's own unit.

## API

- `GET /api/forecast` — settings, state, daily highs and lows, and the next 24 hours.
- `PUT /api/forecast/settings` — `enabled`, `weather_entity`; fetches straight away.
- `POST /api/forecast/refresh` — fetch now.
