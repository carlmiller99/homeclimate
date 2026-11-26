# Notifications

HomeClimate writes everything worth knowing to its log (Settings → Logs). Notifications send the parts you choose to your phone through a Home Assistant notify service. They send messages and do nothing else.

Set them up in **Settings → Notifications**.

## Where they go

Type the notify service to send through, such as `notify.mobile_app_my_phone`. In Home Assistant, Developer Tools → Actions lists the ones you have. **Send a Test** sends one message straight away so you can check it arrives; it works whether or not notifications are switched on.

Nothing is sent until **Send Notifications** is on and a service is set.

## What is sent

- **How Serious**: warnings and errors, or errors only. Warnings include things that fixed themselves.
- **About**: which parts of HomeClimate to hear from. Heating and cooling (which is where safety limits are) and the fireplace are chosen to start with. The others are changes made from outside HomeClimate to a vent or thermostat, the weather forecast, sign-in problems, and HomeClimate itself.
- **Daily Summary**: one message a day at the hour you choose (house time), saying how long heating and cooling ran yesterday and how many warnings and errors were logged. If HomeClimate was not running at that hour it is sent later the same day.

## So it stays useful

- The same message is not sent again for six hours. Messages that differ only in their numbers ("deferred 5 min", then "4 min") count as the same.
- No more than six warnings are sent in an hour, and when that limit is reached one last message says there is more in the log. Errors have six of their own, so a run of warnings can never crowd one out.
- Sending never holds anything up: a message is handed off and given ten seconds; one that could not be sent may be sent when it next comes up.
- After a restart, a standing problem is reported again.
- Nothing is sent while Dev Mode is on, unless **Also Send in Dev Mode** is on.
- Nothing is sent while Home Assistant is disconnected, because the message would have nowhere to go.
- If Home Assistant refuses a message (a wrong service name, usually), the section says so the next time it is opened.
- Only notify services and notify groups are supported (`notify.mobile_app_…`, `notify.notify`, a group you made). The newer notify entities, sent to with `notify.send_message`, are not.
- Notifications are real messages even in Dev Mode: Dev Mode stops HomeClimate commanding your equipment, not your phone. That is why they are off in Dev Mode unless you ask.

## API

- `GET /api/notifications` returns the settings, the categories that can be chosen, and whether the last send failed.
- `PUT /api/notifications/settings` takes any of `enabled`, `service`, `level` (`warning` or `error`), `categories`, `daily_summary`, `summary_hour` (0 to 23), `in_dev_mode`.
- `POST /api/notifications/test` sends a test message now.
