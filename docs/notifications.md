# Notifications

HomeClimate writes everything worth knowing to its log (Settings → Logs). Notifications send the parts you choose to your phone through a Home Assistant notify service. They send messages and do nothing else.

Set them up in **Settings → Notifications**.

## Where they go

Type the notify service to send through, such as `notify.mobile_app_my_phone`. In Home Assistant, Developer Tools → Actions lists the ones you have. **Send a Test** sends one message straight away so you can check it arrives; it works whether or not notifications are switched on.

Nothing is sent until **Send Notifications** is on and a service is set.

## What is sent

- **How Serious**: warnings and errors, or errors only. Warnings include things that fixed themselves.
- **About**: which parts of HomeClimate to hear from. Heating and cooling, the Home Assistant connection and the fireplace are chosen to start with.
- **Daily Summary**: one message a day at the hour you choose (house time), saying how long heating and cooling ran yesterday and how many warnings and errors were logged.

## So it stays useful

- The same message is not sent again for six hours.
- No more than six messages are sent in an hour. When that limit is reached, one last message says there is more in the log.
- Nothing is sent while Dev Mode is on, unless **Also Send in Dev Mode** is on.
- Nothing is sent while Home Assistant is disconnected, because the message would have nowhere to go.
- If Home Assistant refuses a message (a wrong service name, usually), the section says the last notification could not be sent.

## API

- `GET /api/notifications` returns the settings, the categories that can be chosen, and whether the last send failed.
- `PUT /api/notifications/settings` takes any of `enabled`, `service`, `level` (`warning` or `error`), `categories`, `daily_summary`, `summary_hour` (0 to 23), `in_dev_mode`.
- `POST /api/notifications/test` sends a test message now.
