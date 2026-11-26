# הסמסטרון — recording downloads (Chrome extension)

One tap on **⬇ הורדה** in the tracker downloads that Panopto recording to
`Downloads/הקלטות/<course>/` — the camera (the board, with the sound) in 1080p, plus the slides
(`- מצגת`) only for the sessions listed in the semester file's `panopto.screens`; play the two
together with LectureSync. When a lecture has two extra screens, the slides are the one with the
lower bitrate. Camera quality: `CAMERA_MAX_HEIGHT` in background.js (720 → 540p, ~1 GB a lecture).

⌥-click on ⬇ = diagnose only: no video, a report in `Downloads/הקלטות/_diagnose.json` (stream
tags, playlists, sizes; addresses without their signed part). For personal offline viewing only.

Install once, in Chrome on the computer: `chrome://extensions` → Developer mode → **Load unpacked**
→ choose this `extension` folder. You need to be logged in to Panopto in that Chrome
(open any recording once). Chrome on Android doesn't run extensions.

How it works: asks Panopto for the recording's streams (DeliveryInfo, with your Chrome login),
reads the HLS playlists, and downloads each stream's single fragmented .mp4. If that fails it
opens the viewer in a background tab, catches the fragmented.mp4 requests (like the "Panopto
Media Downloader" extension), downloads them and closes the tab.
