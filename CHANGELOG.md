# Changelog

All notable changes to this project. This project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- **A call in progress is marked as one, wherever the panel shows it.** Until now a meeting still
  running sat in the list looking exactly like the dozen finished ones above it, and only the popup
  hinted otherwise — so the panel quietly invited you to read numbers that were still moving as if
  they were final. A live call now wears a marker with the time it has been running, its row is
  washed in the present-green and its date badge is lit, and a marker beside the name of the app
  says a call is on from every view and leads to it. Its detail page leaves the hours open
  (`09:00–…`) rather than printing the current time as the hour it finished at.
- **The panel keeps up with a call instead of freezing at the moment it was opened.** It follows
  what the tracker writes and redraws when a call is joined, left or ended, and the clocks tick
  where they stand. A repaint waits for the page to be idle: a batch being picked, an open modal,
  menu or rename is never pulled out from under you, and lands as soon as it is let go.
- **A record nothing ended says so, and offers the way out.** It is marked in amber as unfinished,
  the marker names the last moment anything was heard from the call, and one badge closes the
  record at exactly that moment — the same repair the worker runs on its own for a call whose link
  is gone from the browser, offered by hand for the one case it cannot judge, where the Meet tab is
  still open and the call may as well still be running.
- **A call in progress survives the extension going away.** Reloading, updating or switching the
  extension off cuts the tracker in the page off from the rest of the extension: it keeps running,
  but nothing it reports arrives anywhere, and Chrome puts a script into tabs that load afterwards,
  not into the ones already open. So the worker now puts a tracker back into every Meet tab that
  hasn't got one, whenever it wakes, and the call is resumed into the record it was already
  keeping. A tab that answers is left alone, because replacing a working tracker would open the
  participant panel in the user's face for nothing.
- **A call already running when the extension arrives is picked up on the spot**, with no record
  of it ever having begun. Installing mid-meeting, or turning tracking back on mid-meeting, no
  longer means waiting for the next call to see anything.
- **The page says it is still on the call once a minute.** Nothing else did: a call where nobody
  comes or goes records no events for an hour, so a meeting the browser was killed on could only
  be ended where somebody last arrived — an hour of it thrown away. It is ended at the last
  minute it was known to be running instead.

### Changed
- **The spreadsheet is only ever added to.** "Send everything" used to clear the three tabs and
  write the register out afresh, which made the sheet a mirror of this machine rather than a backup
  of it: a meeting deleted here, or one recorded on a machine this copy has never met, was wiped
  from the sheet by the next send. It now offers the finished meetings the sheet has not got and
  leaves everything it already carries exactly as it was sent — and there is no longer any call in
  the extension that can clear a range, so no sequence of clicks can cost the sheet a record.
  Restoring was already additive and stays that way. To change or drop what the backup holds, edit
  it in Google Sheets, or create a new sheet and send everything to that one.
- **Sending and restoring say what they left as it was, and what can be done about it.** A count in
  a toast that has gone in two seconds is no use for a suggestion, so the advice stays under step 3
  until the next attempt, with the sheet a click away: meetings the sheet already had, calls still
  running that go up when they end, and — on the way back — records that stayed in the trash rather
  than being restored behind the deletion.

### Fixed
- **A record nothing ended no longer passes for a call in progress.** Presence cannot tell the two
  apart — a record nobody closed has everyone still standing inside it — so a call the browser was
  killed on read as running, and its length grew with the wall clock, until it was four hours stale.
  The last sign of life decides now: the page reports in once a minute, and three minutes without
  one is a call nothing is watching any more. Its hours stop where they stopped, its length stops
  growing, and the panel says nobody can vouch for it rather than claiming it is live.
- **A meeting nothing got to end no longer runs on for hours.** The browser closed on it, the tab
  went while the worker was asleep, the extension was switched off: the record was left open with
  everyone still inside it, reading as in progress and growing with the clock until it was four
  hours stale. Whenever the worker wakes it now ends whatever has been abandoned, and at browser
  start it ends everything left open, since no call survives the browser going away. Records left
  open by earlier versions are put right the same way.
- **One page load can no longer open two records for one call.** The first participants and the
  start of the meeting are reported at the same moment, and reading the store to decide which
  session they belong to took long enough for both to arrive first and each open a record of its
  own, stamped a millisecond apart.
- **A tracker cut off from the extension stands down** instead of scanning the call every five
  seconds for the rest of the day and throwing on every send. Sending from a page whose extension
  has gone throws rather than rejecting, which the `.catch()` on it never held.
- **Closing a second tab on the same link no longer ends the call.** A link opened twice — the
  green room left in one tab while the call runs in another — meant the second tab held its own
  copy of the record, taken when it opened, and closing it wrote that copy back over the call and
  marked it finished: everyone who had arrived in the meantime was gone from the register. A tab
  closing now only says the call was live until that moment, and which records that leaves
  abandoned is worked out the way every other recovery works it out, by the links no longer open
  anywhere.
- **A finished meeting no longer has people standing in it.** The page reports on the people the
  current load of it has seen, and a resumed record holds more than that — anyone it never saw kept
  an open session and read as "in call" for the life of the record, in the panel, the report and
  the export alike. Everyone still open is closed where the meeting ended.
- **A scan that was on its way when the call finished no longer reopens it.** The last few seconds
  of a call are busy, and a report already in flight arrived after the end and undid it, leaving a
  meeting that had finished cleanly marked as one nobody ever ended. A record only reopens for a
  write that carries something later than the end, which is what a rejoin is.
- **A tracker put into a tab where the call is already over leaves it alone.** Leaving a call keeps
  its code in the address bar, so a tab still showing "you left the meeting" looked exactly like one
  in a call: putting a tracker back into it — after an update, or after switching the extension back
  on — opened a record for a call that had finished hours ago, or ended a real one at the wrong
  hour. Meet says plainly when a call is over, and that is now asked before anything is recorded.
- **A restored tab no longer brings yesterday's call back to life.** At browser start a tab put back
  on a Meet link got a tracker, and the tracker resumed the record the crash had left open, so a
  call that ended when the browser did carried on growing. Nothing a browser has just started can
  be tracking a call that predates it, and the pass that ends abandoned meetings now says so.
- **A meeting renamed while it is still running keeps its name.** The tracker holds the title it
  scraped when the call opened and writes it again every few seconds, which took the rename back
  within seconds of it being made.
- **A meeting is named after its calendar event, not its code, when a tracker joins a call already
  in progress.** The first message to reach the worker is the one that opens the record, and only
  the start of the meeting carries the title and the link; a first scan that got there ahead of it
  left the meeting named `abc-defg-hij` for good.
- **Reloading a Meet tab mid-call no longer hands the spreadsheet half a meeting.** A reload ends
  the record on the way out and resumes it a moment later, and the sheet was written the instant it
  ended — where, being append-only, that half stayed as the backup's version of the call. A page
  going away is now told apart from a call ending, and only the second is worth writing home about.
- **Entering another call in the same tab closes the first.** Meet can move between calls without a
  page load, and the end was only noticed when the address bar lost its code altogether, so the
  second call was recorded into the first one's register.
- **Two things at once can no longer lose one of them.** Every write reads the whole register,
  changes it and writes it back, and the worker did that from several places at the same time: a
  heartbeat, a scan, a recovery pass, and the end of a call all racing. They queue now, one at a
  time, with the spreadsheet left outside the queue where a request that never answers cannot hold
  up a call being tracked behind it.
- **An edit made during a call is no longer taken back by the call.** The queue above only holds
  within the worker, and the dashboard writes to the same register from a page of its own: a rename
  or a merge made while a meeting was being recorded could be written over by the tracker's next
  write, seconds later and for good. Every write now carries a revision, a change worked out from a
  register that has since moved is worked out again on what is there now, and a write that turns
  out to have gone over a change nobody here had seen puts that change back with its own on top.
- **Lowering "meetings to keep" no longer writes back the register as the page found it.** The trim
  was made from the copy the dashboard was holding, which could be an hour old and knew nothing of
  the call recorded into it since; it reads the store now.
- **Rejoining a call you left is tracked.** Meet puts you back in from the "you left the meeting"
  screen without a page load, and the call keeps its code in the address bar the whole time it is
  up — so the tracker, which refuses to start a call it has already finished at this address, had
  nothing left to tell the two apart with, and everything after the rejoin went unrecorded. Meet's
  own call controls coming back on screen is what says the call is up again, and the record is
  resumed rather than started over.
- **A link you opened and never joined is no longer a meeting in the register.** The record is
  opened as soon as the tab is on a call, which is what puts a call in progress on the panel the
  moment it starts — but a green room left standing, or a Meet address in a tab nobody went back
  to, then ended as a meeting with nobody in it and stayed there, and went up to the spreadsheet,
  which never forgets. A record with no participant, no event and nothing given to it by hand goes
  instead of being ended. One that was named, filed under a series or set aside is the user's, and
  stays whatever it holds.
- **A meeting goes up to the spreadsheet once it can no longer change.** The backup is written once
  and never corrected, and a call that has just ended is exactly the call that can still come back:
  rejoining the link resumes the record, and a second tab still in the meeting reopens it on its
  next scan. Either would have left the sheet holding the half of the meeting that happened before
  it, for good. A record now waits out the window it could be resumed in — two minutes, or the next
  pass — and what the sheet is given is the whole call.
- **The spreadsheet no longer hands back the meetings "meetings to keep" has just dropped.** They
  came home on the next pass and were dropped again by the next write, so a full register fetched
  the same old meetings over and over. A register at its limit now asks for nothing older than the
  oldest meeting it is keeping; raising the setting lifts that floor and brings them back.
- **A call joined before the hour it was scheduled for no longer reads as not happening.** The
  meeting keeps the hours of its calendar event, so that joining early cannot stretch it — but
  until the hour comes those hours are ahead of the clock, and everything measured from them said
  the same thing: a clock at `00:00:00`, a length of nothing, and everyone in the call credited
  with none of it. Ten minutes early is now ten minutes of a meeting that is plainly on, and the
  hour takes over the moment it arrives. Its timeline is drawn over the same window, where before
  the blocks had nowhere to go, and hours pinned by hand behind the end of a meeting no longer
  leave it with no length either.
- **The spreadsheet's Meetings tab says what the dashboard says.** Its start, end and duration were
  the moments tracking happened to begin and stop, so a meeting with hours of its own read minutes
  longer up there than it did here.
- **Leaving a call in one tab no longer ends it in another.** Two tabs on one link are two pages on
  one meeting, and one of them leaving says nothing about the other: the record was cut short at
  that moment and everyone still in the call was marked as gone, and it stayed that way until the
  last page left — long enough for the spreadsheet, which is written once, to be handed half a
  meeting. The end that ends a record is now the last one. A page that has never seen anybody
  itself, which is what sitting in the green room of the same link looks like, does not hold a call
  open behind it.
- **A tab that goes from one call to the next keeps the two apart.** The page says it has left on
  its way out, and that is the one message that can go missing, being sent while the page is being
  taken down: everything the tab reported from then on was recorded into the call it had left,
  under that meeting's title, and the second meeting was never written down at all. What a page
  says now has to be about the call the tab is reporting into.
- **The screen you land on when you leave a call can no longer put the tracker in a loop.** There
  were two readings of "this call is over", and they did not agree about one of Meet's markers: the
  end detection stopped the call on it, and the watchdog, which had never heard of it, started the
  call again three seconds later — over and over for as long as the page was left open, each turn
  opening a record, ending it, and sending the spreadsheet after it. There is one list of them now,
  and everything that asks the question reads it.
- **A meeting goes up to the spreadsheet once, not twice.** A pass works out what to send by
  reading what the sheet already has, so two passes running at once both found the same meetings
  missing and both sent them — and the sheet is only ever added to, so a row sent twice stays there
  twice. The worker is told to wake twice when the browser starts, which made that the ordinary
  case rather than a rare one. It now runs one pass at a time, and an unattended pass writes down
  that it is running, so an open dashboard and the worker no longer set off together.
- **A write the store refuses is no longer silent.** Chrome answers a store that has filled up by
  doing nothing and saying so afterwards, which nothing here was listening for: the call went on
  being recorded into a register that was no longer taking it. It is reported now, so a record that
  vanished can be traced to the reason rather than guessed at.
- **A merge is no longer baked in by reloading the tab.** Two Meet identities of one person are
  kept apart on disk with the alias beside them, which is the whole reason a merge can be taken
  back. But a call picked up again (a reload, an update, the worker being stopped and started) was
  handed the merged view to carry on from, and wrote it back as one participant holding both
  people's events. From then on the merge was part of the record: undoing it returned the other
  identity with nothing in it, and every backup and export carried the lump. A resumed record now
  comes back exactly as it is stored.
- **Whoever is running the meeting attends more than five seconds of it.** Meet does not always
  list you in the participant panel under the name it shows you by, so you were found by the
  separate look for yourself instead, which ran after the check for who had left rather than
  before it. The next scan read only what the panel gave it, recorded you as having left, and
  never found you again. Both ways of spotting somebody now report the same way, so the host is in
  the call like anybody else, and an address Meet only reveals later no longer costs a rejoin a
  scan.
- **A presence block stays on its own track.** Hours pinned behind a session, from a schedule read
  off the wrong calendar entry or somebody joining after the hour the event was booked to end, put
  the block past the end of a lane that nothing clips. A block with nothing left of it inside the
  meeting's hours is no longer drawn at all, and a record whose hours cannot be read (which an
  imported file is free to carry) no longer takes the whole detail page down with it.
- **The spreadsheet counts a merged person once.** The two tabs meant for people to read listed
  both Meet identities and counted them both, so a meeting that reads as eleven people here read
  as twelve up there. They now show the meeting as the app shows it. The Backup tab still holds
  the record exactly as it is stored, so restoring it can still take the merge back.
- **A name goes into the spreadsheet as a name.** Rows are written as if typed, which is what makes
  a duration arrive as a number, and also what makes anything beginning with `=` arrive as a
  formula. Half of what goes up there is other people's display names, chosen by them: somebody
  calling themselves `=IMAGE("http://…")` was writing into the user's own spreadsheet. Those cells
  are marked as text now.
- **The popup and the report escape quotes as the dashboard does.** A quote in a title or in a
  meeting's id, which a file brought in from elsewhere is free to carry, could step out of the
  attribute it was written into.
- **The extension says which Chrome it actually needs.** It asked for 91 while its colours are
  mixed with `color-mix()`, which arrived in 111, so on anything older it installed and then came
  up with pieces of itself missing.
- **A change put back is put back whole.** Where two contexts wrote at once, the one that landed
  second re-worked its change on what it had gone over and wrote the two together, unless the
  re-run found nothing left of its own to do: then it returned, and what stood in the store was
  its own write, still sitting on top of the other. Emptying the trash beside a single deletion
  brought the trash back. It now puts back what it went over either way.
- **The trash is guarded like the register.** Deleting is two writes, and the second is the one
  that matters: the record leaves the register first and only then arrives in the trash. Both
  halves go through the same guarded write now, so nothing that clears the trash beside a deletion
  can drop the meeting out of both at once.
- **Restoring a backup keeps the meetings it says it keeps.** A sheet or a file can carry more
  than "meetings to keep" allows, and all of them were taken in and counted, then quietly thinned
  by the first call recorded afterwards. The limit is applied on the way in, the count is what was
  kept, and the note under the sheet says how many were left up there and how to fetch them.
- **A meeting stops being called `abc-defg-hij`.** The record is opened the moment a tab is on a
  call, when the tab title is usually still the bare code; Meet puts the calendar event there once
  the call is up, by which time nothing was left that would notice. The page says what it sees
  every minute, and the record takes the name up the first time it says something better. A name
  given by hand is still never touched, and a tab that has not been told the meeting's name can no
  longer write its code over one that has.
- **The archive is out of the figures, not just out of the list.** Meetings set aside still
  counted in the read-out at the top and in the People tab, so putting a meeting away moved it and
  changed nothing about the numbers standing for the whole register. Analytics carries a switch for
  counting them anyway, which appears once there is an archive to count.
- **A name is written to a CSV as a name.** Excel, Sheets and LibreOffice all read a cell
  beginning with `=` as a formula, and the export carries other people's display names. The export
  marks such a cell as text and the import takes the mark back off, so a file this app wrote still
  imports as the names it was written from.
- **Every CSV this app writes now goes out the same way**, the analytics slice included: it had a
  copy of the writer with a different line ending, which is exactly the sort of thing a second copy
  does.
- **The register has room for what the setting allows.** Two hundred meetings with every join and
  leave can run to several megabytes, which is close enough to the ceiling an extension is held to
  that a write could be refused and a meeting lost. The extension asks for `unlimitedStorage`,
  which grants nothing beyond its own local storage.

## [1.3.3] 2026-08-14

### Added
- **The dashboard reads on a phone.** The tab rail compresses its type and its gaps rather than
  wrapping, so all five tabs hold down to 320px, and it scrolls as a net for anything longer with
  the tab just opened brought into frame. The masthead stacks, so the read-out is a line instead of
  a one-word-wide column. The three wide tables (a meeting's attendance, a series' sessions, a
  person's meetings) fold each row into two or three lines rather than running off the viewport. A
  name wraps to its full length instead of ellipsing behind its own row. The batch toolbar becomes
  the head's content rather than an overlay that landed over the rows. Chevrons, pencils and the
  export glyph, which waited for a hover, are visible where there is no pointer to hover with.
- **A meeting row says the hours it ran**, start to end, where it gave only the start. A call still
  in progress keeps to its start; the chip beside the title says the rest.

### Changed
- **The text buttons carry a leading icon**, on the dashboard, in the report and in the popup.
- **The language is picked from a menu, and its flags are drawn.** An `<option>` holds text and
  nothing else, and a flag emoji is a pair of regional indicators that Windows has no glyphs for,
  so the old `<select>` read as bare "GB" and "PL"; the flags are SVG now, which needs a menu to
  hold them. It answers the same arrow keys and Escape the select did, and Automatic gets a globe.
- **How the head actions give way is decided by the row's own width**, not the window's: the same
  bar sits beside a short title on a wide page and alone under a long one. The search field spreads
  into what is left, dropping to a line of its own when a list switch is out too. Narrower still,
  the labels give way to their glyphs and a switch keeps only its count, with the whole label left
  as the button's name for a pointer and for a screen reader.
- **Exporting a single meeting is a glyph in its row**, quiet until the row is hovered, which gives
  the column back to the columns that carry numbers.
- Between the phone layout and the width where every column fits, a table slides inside its card
  with the name column holding the left edge, rather than pushing the card wider.

### Fixed
- **A theme change no longer leaves elements painted in the theme being left.** Chrome will not
  re-resolve a property that is mid-transition when its value comes from a custom property, and
  switching theme moves the tokens under every transitioned background and border; ghost buttons
  ended up dark text on a dark panel until the page was reloaded. The swap now lands with
  transitions off and lets them back in once the new colours have settled. The popup needed the
  same guard, where the stored theme arrives after the first paint.
- A long toast is capped and centred instead of running past the edge of the window.
- The fifth headline tile fills the bare cell left by a three-column row, which showed the hairline
  background through as a grey block.
- A series badge's menu, the series grid's cards and the trash's *Restore* no longer overflow or
  clip on a narrow window: the menu is capped to the viewport, a card may be narrower than 300px,
  and the action column takes the width its label needs.
- Four ticks collide over a phone-width presence timeline, so only the ends are drawn and the hover
  read-out carries the middle.
- A person's name column in the meetings and people lists may shrink, as the title column already
  could, instead of setting the column width and pushing the rest of the grid off the card.

## [1.3.2] 2026-08-14

### Added
- **A series can be archived.** It keeps its meetings and its numbers, but stays out of the way:
  archived series are not offered when a meeting is put into one, they carry an archive icon by
  the name, and they live behind an *Archive* entry beside *New series*.
- **A meeting can be archived too.** The archive icon in its header sets it aside, the list has an
  *Archive* tab of its own, and a batch can be archived or brought back in one go. An archived
  meeting still counts in its series, in analytics and in reports; it is only out of the list and
  out of the popup's recent meetings.
- **Deleting a meeting now sends it to a trash.** Each row there says how long it has left, a row
  restores on its own and a batch restores or goes for good together. The trash empties itself
  after 30 days (7 / 14 / 30 / 60 / 90 in Settings), swept whenever the dashboard opens or the
  extension wakes. A meeting waiting there is out of every count, chart, export and sync until it
  is restored, and a call thrown away and then rejoined in Meet comes back on its own.
- **Google Sheets sync works in both directions.** A finished meeting still goes up, and meetings
  the sheet holds that this machine is missing now come back down: right after a meeting ends,
  when the dashboard is opened (at most every 5 minutes) and when the extension wakes (at most
  every 6 hours). Neither side is overwritten or cleared, a meeting in the trash is not brought
  back by the copy the sheet still carries, and step 3 shows when the last pass ran.
- **A spreadsheet is pointed at with a link or an ID.** The link from the address bar is enough,
  including the `/u/1/` form, an older `?key=` link and a Drive link; the id is read out of it.
  What cannot be opened, a published copy among others, is refused on the spot.
- **A spreadsheet picked by hand is given the structure it needs.** The *Meetings*, *Participants*
  and *Backup* tabs are created when the sheet is linked rather than at the first sync, and a
  sheet already in use keeps its rows: an existing tab gets its header row inserted above them.
- **Meetings can be added to a series from the series itself**, chosen from a searchable list of
  everything that is not in it yet.
- **The meetings list is paged**, 25 to a page, with the range on the left and page numbers on the
  right; deleting the last record of a page lands on the one before it, not back at the start.
- **Select all** appears in the batch toolbar as soon as one meeting or one person is picked.
- **A block on the presence timeline says which hours it covers**, in the same hover read-out the
  charts use.
- **The series badge leads to the series**, both from the meetings list and from under a meeting's
  title.

### Changed
- **The series a meeting belongs to reads as a badge under its title** and changes right there,
  from the caret beside the name, instead of in a modal over the page.
- **The hours badge is as wide as the hours it shows**, and only widens on hover to make room for
  the pencil.
- **Renaming a title happens in place.** The line keeps its layout while the field is open and the
  pencil stays on the right, instead of the header shifting as you type.
- **A person unfolded in a series stays inside the table's width** rather than stretching the
  matrix under them.
- The weekly rhythm chart is a normal card again, beside its neighbour rather than across the page.
- *Series PDF report* is now simply *PDF report*, as it is on a meeting.
- The three readings in an unfolded person's panel are told apart by dots.
- Auto-sync says what it now does: it keeps the sheet and the register in step, both ways.

### Fixed
- **Reloading a Meet tab mid-meeting no longer loses what was recorded before it.** The page
  starts its own count of the call over on every load, and that was taken as the whole truth:
  everything observed up to the reload was dropped, or the call came back as a second, separate
  meeting. The two are folded together now, someone the reloaded page cannot find again is
  closed out at the moment it picked the call back up rather than left standing as present, and
  a record that ended seconds ago is recognised as the same call resuming.
- **A second meeting joined in the same tab is tracked.** Meet enters one without a page load,
  and tracking stopped for good after the first call ended. Leaving a meeting keeps its code in
  the address bar, so the call just finished is not started again.
- **Auto-tracking shows its real state.** Settings read the switch from the wrong place and drew
  it as on every time the page opened, whatever it was set to.
- **A Google Sheets sync that failed can no longer report success.** A request retried after an
  expired token was returned unchecked, so an error from the second attempt was read as data.
- The participant panel is no longer hunted for indefinitely: after ~30 seconds without it, the
  page is one we cannot read and the search stops.
- Meet's own markup is kept out of the register — the check that separates a name from an
  internal id or a container's text now covers the current user too.
- The series report reads a meeting's hours the way every other view does, so hours set by hand
  or detected from the calendar event show there as well.
- Searching the meetings list no longer breaks on an imported record with no title.
- **Escape while renaming a meeting or a series cancels the edit.** Closing the field counted as
  leaving it, so the name was saved instead.
- Every form field on the dashboard carries a name and a label, so the browser stops reporting
  unnamed and unlabelled fields.

### Removed
- The copy button in a meeting's header; the place it took under the title is the series badge.
- The presence timeline's grid lines. They lined up with the axis over the lanes, but the same
  track is reused under a session block where there is no axis for them to belong to, and there
  they read as a stray mark across the bar.
- Unused code: an English-only CSV helper, an unreferenced Sheets write and import lookup, a
  canvas clear that nothing called, and 22 message-catalogue entries no longer shown anywhere.

## [1.3.1] 2026-08-14

### Added
- **Batch actions.** Click a meeting's date badge or a person's avatar and it becomes a checkbox,
  with a toolbar over the list header — the page does not move, nothing is pushed down. Meetings
  can be added to a series, exported to one CSV or deleted together; participants of a meeting can
  be merged into one person or added to the roster; people in a series can be added to or removed
  from its roster; people in the list can be added to the default roster or copied out. Once
  something is picked, clicking a row adds it to the batch instead of navigating away.
- **A series lists its sessions**, each a row straight into that meeting, with its hours, size,
  length and average attendance.
- **The spreadsheet is a real backup.** Alongside the readable *Meetings* and *Participants* tabs,
  a *Backup* tab now carries every stored record verbatim — raw joins and leaves, e-mails, meeting
  hours, merges and series — split across cells when a record is long. **Send everything** writes
  the whole register to the sheet and **Restore from the sheet** brings it back, adding what is
  missing and leaving what is already here untouched.

### Changed
- **A person unfolds in place.** In *People* and in a series' attendance matrix, clicking someone
  opens their detail under their own row and folds the previous one away, instead of a panel at the
  top of the page or a modal over it. Both are still URLs, so back and forward work as before.
- **Google Sheets setup is three visible steps** — connect an account, point at a spreadsheet, use
  it — with the steps you cannot reach yet dimmed rather than hidden, and the linked sheet named
  rather than shown as a raw id.
- **One button size.** The small variant sat too low beside a text field, so it is gone.
- The person's meetings table has fixed column widths, so a long meeting title can no longer
  squeeze the date out of its column.
- Timestamps written to Sheets are ISO instants rather than locale-formatted text.

### Removed
- The timeline's **left early** marker and its legend entry. Attendance has been binary since 1.3.0;
  how much of a meeting someone was there for is reported as time and share.
- The series matrix hint, replaced by the session list above.
- Unused code: the stacked bar chart helper and two unreferenced Sheets lookups.

### Fixed
- A stray NUL byte in `sheets-api.js` made Git treat the file as binary.

## [1.3.0] 2026-08-13

### Added
- **Analytics is now a filtered workbench.** One filter row scopes everything below it:
  a **date range** (7 / 30 / 90 days, 12 months, everything, or a custom from–to), a
  **series** picker and a **meeting** picker — both multi-select popovers that list only
  what the other filters still allow, with live counts. The slice is remembered between
  sessions and exports to CSV.
- **Headline numbers** — meetings, total time, people, average attendance and average meeting
  size, each against the previous period of the same length.
- **New charts** — meeting activity over time (buckets switch between day / week / month with
  the range), average length vs. presence, a **weekday × hour heatmap** of when meetings start,
  the distribution of attendance share, most frequent meetings, most present people, and a
  series comparison.
- **Read-outs** — busiest day, peak hour, longest meeting, biggest turnout, the most regular
  person, who stays longest and who leaves earliest, and the attendance trend.
- Every chart card flips to the **table it was drawn from**, so no value is only reachable
  by hovering, and each chart has a hover read-out.
- **Click a participant in a series** — the attendance matrix opens a panel with that person's
  exact presence in every session: the meeting hours as the track, their join/leave blocks on it
  and the same intervals written out, absent sessions included.
- **Every view has a URL** — `#meetings`, `#meeting=<id>`, `#groups`, `#group=<id>[&person=…]`,
  `#people[&person=…]`, `#analytics`, `#settings`. The browser's back and forward buttons work,
  views can be linked to, and the in-app back control lands where its label says.
- **Import a CSV this extension wrote** — Settings → *Import backup* now takes a JSON backup **or**
  a CSV of ours (a single meeting, a series file, or the combined export, in either language). Rows
  are matched back to the meetings they came from by the new `ID` column, so re-importing a file you
  already have adds nothing, and a series named in the file is matched to an existing one or created.
- **Import from another attendance extension** — Settings → *Import from another app* converts a
  backup and merges it in; RollCall (meet-attendance.com) is the first supported source.
- **Attendance share in every matrix cell**, on screen and in the series PDF, plus a **% of series**
  column in the report: time present against the summed meeting hours, so missing a whole session
  costs what it should.
- **Undo a merge** — a merged participant can be split back into the entries it was folded from.
- **Meeting hours** read out as an editable badge under the title, marked when they were set by hand.

### Changed
- **Attendance is binary.** Arriving late no longer makes anyone less present: the *late* status,
  the lateness threshold setting and the timeline's late marker are gone.
  How much of a meeting someone was there for is reported as time and share, which is where the
  nuance belongs.
- **Richer CSV exports.** One row per participant per meeting with the same columns everywhere
  (date, meeting, code, series, meeting hours and length, participant, e-mail, status, first seen,
  last left, presence as `HH:MM:SS` *and* in minutes, share, presence blocks, **joins & leaves as a
  JSON array**, merged-from names, and the meeting's id). The series file carries both readings: the
  matrix first, then the per-session detail. Files are CRLF + BOM so Excel opens them without
  mangling Polish. Times are minute-resolution, so a CSV round trip can come back up to a minute per
  session higher — the JSON backup is the lossless path.
- **The JSON backup no longer bakes merges in.** Participants export exactly as they were recorded,
  with the merge riding along as the meeting's `nameMap` plus a readable `mergeInto` on each folded
  entry; import folds them back and writes unmerged records, so a merge survives a round trip and
  can still be undone.
- **PDF reports open in the same tab** and carry their own *Back* button, which is hidden on paper.
- **Meeting detail** reworked: renaming is a pencil beside the title (as in the series head), and the
  action row matches the series — *Copy · Export CSV · PDF report · delete*.
- **Data model v4.**

### Fixed
- **A merged participant no longer loses time.** Two Meet identities of one person produce
  overlapping event streams; pairing each join with the next leave closed a session on the wrong
  stream's leave and silently dropped every overlapping stretch. Sessions are now the union of the
  intervals the events describe.
- **Importing no longer bakes existing merges in permanently** — the import path wrote the merged
  *view* back to storage, which made earlier merges impossible to undo.
- **Long meeting names are no longer sliced off** in "Most frequent meetings". Labels used a
  fixed 122px gutter and a blind 18-character cut, so a long title ran off the left edge of
  the canvas ("…kolenie - AI w p…"). The gutter is now measured from the actual labels and
  each one is fitted to the width it really has, with the full title in the hover read-out
  and the table view.
- **The series matrix header** showed the raw string `matrixPerson` instead of a heading.
- **CSV dates** were the UTC day, so a late-evening meeting could be filed a day early, and
  export file names no longer carry a 200-character meeting title.

### Migration
- v3 → v4 unbakes merges that earlier versions had written into the stored records: the folded
  entries come back under their own names with the merge kept as a `nameMap`, so they can be
  split apart again. Raw events are preserved and everything is re-derived.

## [1.2.1] 2026-08-12

### Added
- **Edit participant names & merge duplicates** — a pencil on each row of the meeting's
  attendance table opens an editor: fix the display name, or enter/pick another participant's
  name to **merge the two entries into one person** (their joins & leaves are combined and
  sessions, lateness and share re-derived). Useful when someone joins under a different name
  and is counted as a new person. Edits are stored as a per-meeting alias map (`nameMap`) and
  re-applied on every write, so they survive live-meeting updates, rejoins under the old name,
  and flow through to reports, CSV exports and Sheets sync.
- **Editable meeting hours** — an *Hours* button in the meeting detail pins the official start
  and end (`scheduledStart` / `scheduledEnd`). They are read automatically from the calendar
  event Meet displays when it can be found, and can always be corrected by hand; the editor
  shows the tracked activity window for reference and offers a way back to automatic.

### Fixed
- **Joining early no longer marks everyone late.** The tracked `date` is merely when the tab
  was opened, and the meeting start was pulled back to the earliest join — so opening the call
  15 minutes ahead flagged everyone arriving on time as 15 minutes late. Lateness, length and
  attendance share are now measured against the meeting's hours, and a scheduled start is never
  dragged backwards by an early join. Time actually connected is still reported in full.

## [1.2.0] 2026-07-24 · fork by [KMChris](https://github.com/KMChris/google-meet-attendance-extension)

First release of the fork — a full redesign plus new capabilities.

### Added
- **Design system** — a bespoke "presence instrument" look; the **presence timeline**
  (every join/leave per participant on the meeting clock) is the signature element.
- **Series** — bundle recurring sessions (e.g. a weekend training); recurring Meet links
  are auto-detected. Each series has an aggregate **attendance matrix** (people × sessions), its own
  roster, and its own report.
- **Dark mode** — follows the browser's `prefers-color-scheme`, with a System / Light / Dark override.
- **Technical PDF reports** — for a single meeting *and* for a whole series, including every
  join/leave event with session durations and roster reconciliation.
- Full **English + Polish** localization (auto-detected, switchable).
- **People** and **Analytics** views.
- **Unlimited storage** — the “Meetings to keep” setting adds an *Unlimited* option (plus a 1000 step) beside the existing caps.

### Changed
- **Data model v3**: unique per-session `id` (`<code>-<startMs>`) plus a separate `meetingCode`;
  derived `sessions` / `firstSeen` / `lastLeft`. Series stored under `meetingGroups`.
- **"Late"** is measured from the meeting start (previously: from the first participant to join).
- **Architecture**: dashboard / report / popup are ES-module pages importing a shared `src/lib`
  layer (`attendance.js`, `storage.js`, `i18n.js`); the service worker is slimmed to event
  ingestion, badge, migration and Sheets sync.
- **Typography**: Space Grotesk + IBM Plex Sans + IBM Plex Mono, self-hosted (latin + latin-ext).

### Fixed
- **Recurring meetings on the same link no longer overwrite each other** — each session is its own record.
- **"First seen"** now reports the first-ever join for participants who left and rejoined.
- **Durations** no longer tick forever for abandoned/stale meetings (clamped to the meeting end).

### Migration
- Legacy `meetings` objects and v2 records (without `sessions`/`meetingCode`) are migrated
  automatically on extension update; raw `events` are preserved and everything re-derived.

---

## Upstream history (starone99)

- **1.1.0**: Auto-sync to Google Sheets on meeting end.
- **1.0.1**: Extension key for a consistent extension ID.
- **1.0.0**: Initial release: real-time participant detection, local storage, CSV export.
