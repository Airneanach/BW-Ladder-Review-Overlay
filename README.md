# BW Ladder Review

After your ladder games, this app will review the replay against the training data in the app and give you a grade.

When a game ends, this re-simulates the whole replay through
[OpenBW](https://github.com/OpenBW/openbw), pulls things such as time supply blocked, big fights, etc
and then compares that against the training data to provide you a grade. This is shown in a browser
overlay you can add to your OBS, or just look at in a broser

Launch the app, verify where your game and replays sit, and if you want you can link your twitch for
automated predictions.

Please note that there's currently no cumulative training set up. Once you train it, it's statically set to
whatever that is. If you improve (or unimprove in my case), it will continue to grade you against whatever
it was trained at. I recommend retraining weekly, or at least every couple of weeks to keep it as accurate
as possible.

## Using it

1. Start **BW Ladder Review**.
2. Add your in-game name(s) — one per account you play on. This is the only thing you have
   to fill in; the StarCraft folder and replay file are detected for you, with a green tick
   when they check out.
3. Copy the overlay URL and add it in OBS as a **Browser** source, **1920 × 1080**.
4. Play. Each finished game pops its report card up for 15 seconds.

The app has to remain open while in use to read the replays. This app reads the LastRep file 
from your replays to get it's information.

### Why do I have to enter my IDs?

I couldn't find a way to easily have it tell who you are when playing, so the easiest answer is
to have you (and me) put in your ladder ID(s) and it compares that to the in game names of the replays.
If you have a lot of ladder IDs you'll need to enter them all, but it's a one time process. Once you've
put in your IDs, the app will save them.

### Where are things hidden on your PC

Settings, match history and a crash log live in
`%APPDATA%\bw-ladder-review-overlay\`.

## Train it on your own play

**Do this first — out of the box is trained on my games**

In order to make sure it worked, the app is by default trained on my 1400 MMR replays. You'll want to 
make sure you put in your Ladder IDs, and then use the train button to have it go over YOUR replays
to give an accurate grade. This can be demanding on your PC, and I recommend you do it during a time
where you're not glued to your PC, or are working on something light. Definitely not while you're live.


## What the grades mean

It takes all the stats from the game, your army count, worker count, base count. Time you spent supply
blocked, where you were in comparison to your opponent, etc and calculates that against your trained 
averages. Now this can be a bit misleading if you cheese. I tried to set it so games under 4 minutes 
don't count, but sometimes cheeses are 4:01 and will just be F grades (since you have no eco or bases).

## Overlay options

Append to the browser-source URL:

| Parameter | Default | Does |
| --- | --- | --- |
| `style` | `advanced` | `advanced` = graded report card, `simple` = result banner + three stats |
| `holdMs` | `15000` | How long the card stays on screen |
| `pollMs` | `4000` | How often the page checks for a new result |
| `listCount` | `2` | Graded categories listed per side (1–4) |
| `title` | — | Replaces the report card's heading |
