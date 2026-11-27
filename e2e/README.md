# HomeClimate end-to-end tests

Playwright tests that run against a real Home Assistant and the add-on, both in
Docker Compose.

## What is here

| File | What it does | Run by CI |
|---|---|---|
| `global-setup.ts` | Sets the add-on up by clicking through the UI: zones, rooms and their devices, from real Home Assistant entities | Yes, before the round-trip |
| `tests/temperature-units.spec.ts` | The °F/°C round-trip: types a temperature into each field, reloads, and checks the field shows what was typed | Yes: **Round-trip (F)** and **Round-trip (C)** |
| `tests/time-zones.spec.ts` | Views the house (New York) from a browser in Tokyo and checks stored instants, shown times and tooltips | No: run it by hand after changing how times are shown or read |
| `tests/my-home.ts`, `tests/fixtures.ts`, `tests/temperature-fields.ts` | Helpers, and the list of temperature fields the round-trip must cover | With the round-trip |

There are no screenshot tests. The visual-regression suite, its committed
PNGs and the specs that only took screenshots were removed: they cost a great
deal of CI time and did not check the design.

`tests/temperature-fields.ts` must match `TEMPERATURE_FIELDS` in
`homeclimate/backend/api/routes.py`, and every field marked `ui: true` needs a
`// @covers:` tag in the round-trip spec. `test_temperature_field_parity.py`
fails the build otherwise.

## Why the setup clicks through the UI

Driving the same forms a person uses means a broken Add Zone or Add Room form
fails the build, instead of being papered over by a direct database insert. So
a change to how a zone, a room or a room's devices are created has to be made
in `global-setup.ts` too.

## Running the round-trip locally

**Prerequisites:** Docker, Node 20+, Python 3.9+

```bash
# 1. Start Home Assistant and wait for it to be healthy (about 60 to 90 s)
docker compose -f docker-compose.test.yml up --wait homeassistant

# 2. Create the Home Assistant admin user and a long-lived token
pip install requests websocket-client
python3 e2e/scripts/setup-ha.py \
  --ha-url http://localhost:8123 \
  --output /tmp/ha_token.txt

# 3. Start the add-on with the token
HA_TOKEN=$(cat /tmp/ha_token.txt) \
docker compose -f docker-compose.test.yml up -d homeclimate

# 4. Install Playwright and run
cd e2e && npm ci && npx playwright install chromium
npx playwright test temperature-units.spec.ts --project=chromium
```

For the Celsius leg, add `-f docker-compose.test.celsius.yml` to both
`docker compose` commands and set `HOMECLIMATE_TEMP_UNIT=C` when running
Playwright.

The round-trip changes what the add-on stores, so start from a fresh stack
each time (see Tear down). On a stack that already holds the values it types,
a Save button stays disabled and the test times out.

## Tear down

```bash
docker compose -f docker-compose.test.yml down -v
```

The `-v` flag removes the named volumes (Home Assistant's data and the
add-on's). Leave it off to keep the environment between runs.
