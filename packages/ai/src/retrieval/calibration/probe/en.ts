import type { ProbeLanguage } from "./index.js";

/** Written in en for Stuga. */
export const en: ProbeLanguage = {
  lang: "en",
  topics: [
    {
      id: "food.sourdough-starter",
      short: ["sourdough starter feeding", "revive sourdough starter"],
      question: "How often should I feed my sourdough starter?",
      passages: [
        {
          title: "Sourdough starter",
          headingPath: null,
          body: `Our starter lives in the tall jar on the second shelf. When it sits on the counter, feed it once a day: discard all but about 50 g, then stir in 50 g flour and 50 g lukewarm water. It should double within four to eight hours and smell pleasantly sour. Going away? Put it in the fridge and feed it once a week.`,
        },
        {
          title: "Bread notes",
          headingPath: "Sourdough > Reviving a neglected starter",
          body: `A starter that has sat forgotten in the fridge for weeks is rarely dead, just hungry. Typical signs:

- grey liquid on top (bakers call it hooch): pour it off, or stir it back in for a tangier loaf
- a sharp smell like nail varnish remover, which means the yeast has eaten everything
- little or no rise after a feed

To bring it back:

1. Take a heaped tablespoon from the middle of the jar and discard the rest.
2. Mix it with 50 g flour and 50 g water at about 26 °C. Wholemeal rye wakes it up fastest.
3. Keep it somewhere warm and feed it again every 12 hours.
4. After two or three days it should be bubbly, domed and doubling reliably.

Only bake with it once it doubles within six hours of a feed, two days in a row. A thin film of white yeast on the surface is harmless; pink or orange streaks or fuzzy mould are not, and no amount of feeding will rescue that jar. Start a fresh one instead: a new starter of equal weights of rye flour and water, fed daily, usually takes a week to ten days to become lively enough to bake with.`,
        },
      ],
    },
    {
      id: "food.pickling",
      short: ["quick pickle brine", "pickled onions"],
      question: "What vinegar should I use for quick pickles?",
      passages: [
        {
          title: "Quick pickles",
          headingPath: null,
          body: `Quick pickles (also called fridge pickles) skip canning entirely: vegetables sit in a hot brine and go straight into the fridge. They're ready the next day and keep for about a month.

Basic brine for one 500 ml jar:
- 120 ml vinegar (white wine, cider or rice vinegar)
- 120 ml water
- 1 tsp salt
- 1-2 tsp sugar, optional

Bring everything to a simmer, stirring until the salt and sugar dissolve. Pack sliced vegetables tightly into a clean jar with any aromatics, such as garlic, dill, mustard seed, peppercorns or a strip of lemon peel, and pour the hot brine over until everything is covered. Let it cool, put the lid on and refrigerate.

Good first pickles: red onion rings (ready in an hour), cucumber spears, carrot sticks, radishes, green beans and cauliflower florets. Firm vegetables take longer to soak up flavour, so slice them thinner.

Because quick pickles aren't heat-processed, they aren't shelf-stable. Always keep them cold and use a clean fork to take them out of the jar.`,
        },
        {
          title: "Preserving notebook",
          headingPath: "Pickling > Brine strength and timing",
          body: `Most of our quick pickles use a 1:1 brine, equal parts vinegar and water, which gives a bright, balanced sourness. Notes from a few summers of experimenting:

Vinegar
Use vinegar labelled at least 5% acidity. A 1:1 brine brings that down to roughly 2.5%, which is plenty for fridge pickles. For a sharper pickle, go 2 parts vinegar to 1 part water; for something mild enough to eat by the handful, 1 part vinegar to 2 parts water works but shortens the fridge life to a couple of weeks. White distilled vinegar keeps colours bright, cider vinegar adds fruitiness, and rice vinegar is the gentlest.

Salt
Around 1 tablespoon of salt per litre of brine is a good starting point. Use pickling salt or fine sea salt; table salt with anti-caking agents can make the brine cloudy. Fermented pickles are a different method entirely, with no vinegar, a 3-5% salt brine and a week or more on the counter, so don't mix up the two recipes.

Sugar
Optional, but a little rounds off the acid. We use 1-2 tablespoons per litre for cucumbers and up to 4 for beetroot or red onions, which can take a sweeter brine.

Timing by vegetable
- Red onions: 30-60 minutes
- Cucumbers, sliced: overnight; spears: 2 days
- Carrots and green beans: 2-3 days
- Beetroot (cooked first): 1-2 days
- Cauliflower: 3 days

Hot or cold brine?
Pour hot brine over firm vegetables (carrots, beans, cauliflower) so it penetrates faster. Let the brine cool first for delicate things such as cucumbers or soft herbs, or they go limp. Either way, make sure every piece sits below the surface; anything poking out softens and discolours.

Keeping them crisp
Soft pickles usually come from cucumbers that weren't fresh, slices cut too thin, or forgetting the blossom-end trim: that end holds an enzyme that softens the flesh. A vine or oak leaf in the jar helps, as does chilling the cucumbers in iced water for half an hour before packing.

Things that look wrong but aren't
- Garlic turning blue or green: a harmless reaction with the acid.
- Cloudy brine in the first days: often hard water or table salt.
- Spices sinking or floating: normal.

Things that are wrong
Fuzzy mould, a slimy texture, a bulging lid or an off smell. Get rid of the whole jar; don't scrape the top and hope.

Reusing brine
You can reuse a brine once for a quick batch of onions, but it will be weaker, so top it up with fresh vinegar. Don't reuse brine that held fish or eggs.

Jars
Any glass jar with a tight lid works for fridge pickles; they don't need sterilising like jars for canning, just a hot, soapy wash and a rinse. Wide-mouthed jars are easier to pack and to fish the last pieces out of. Avoid metal lids that are scratched or rusty inside, since vinegar corrodes them; a square of baking parchment under the lid stops the brine touching the metal.

Labelling
Write the date and the brine on masking tape on the lid, for example "1:1, 2 tbsp sugar, 12 Aug". Most fridge pickles are at their best within four weeks, and anything older than two months gets thrown away.`,
        },
      ],
    },
    {
      id: "food.coffee-brewing",
      short: ["pour-over grind", "coffee to water ratio"],
      question: "Why is my pour-over coffee so bitter?",
      passages: [
        {
          title: "Pour-over at home",
          headingPath: null,
          body: `This is the method we've settled on for the office pour-over. It makes one large mug and takes about four minutes, most of it waiting.

What you need
- a cone dripper and filters to fit it
- a burr grinder (blade grinders give an uneven grind that brews unevenly)
- a gooseneck kettle, for a slow, controlled pour
- digital scales that read to 0.1 g, plus a timer
- fresh beans, ideally roasted one to four weeks ago

The recipe
- 15 g coffee to 250 g water, a ratio of about 1:16.7. Anywhere from 1:15 (stronger) to 1:17 (lighter) is fine; pick one and stick to it while you adjust everything else.
- Grind medium-fine, a little coarser than table salt.
- Water just off the boil, around 93-96 °C. Lighter roasts like it hotter, dark roasts a touch cooler.

Step by step
1. Fold the filter along its seam, sit it in the cone and rinse it with hot water. This washes out any papery taste and warms the dripper and mug. Tip that water away.
2. Add the ground coffee and give the cone a gentle shake so the bed is flat.
3. Start the timer and pour about 40 g of water, just enough to wet all the grounds. This is the bloom: fresh coffee releases carbon dioxide and puffs up. Wait 30-45 seconds.
4. Pour slowly in small circles from the centre outwards, avoiding the edges of the filter, until the scales read 150 g.
5. Pause until the level drops a little, then continue to 250 g.
6. Let it drain. Total time should land between 2:45 and 3:30.

Dialling in
Taste is the only measure that matters, but the clock helps you get there.
- Sour, thin or salty, and the brew finished quickly: grind finer.
- Bitter, dry or harsh, and the brew dragged past four minutes: grind coarser.
- Weak but balanced: use more coffee or less water, not a finer grind.
Change one thing at a time and write it down. A grind setting that works for one bag of beans may need a click or two for the next.

Water
Coffee is over 98% water, so it matters. Very hard water dulls flavour and scales the kettle; very soft water can taste flat. Filtered water is a safe default. Avoid distilled water, which brews a hollow cup.

Storing beans
Keep beans in an airtight, opaque container at room temperature and grind just before brewing. Ground coffee goes stale within the hour. The freezer works for beans you won't open for a month or more, but thaw the sealed bag fully before you break the seal so moisture doesn't condense on the beans.

Common mistakes
- Pouring straight onto the filter walls, so water bypasses the coffee.
- Using boiling water from a full kettle on dark roasts.
- Grinding the night before to save time in the morning. It saves a minute and costs most of the flavour.
- Letting the kettle sit for ten minutes after boiling, so the water has cooled well below brewing temperature.
- Measuring by scoop: a scoop of light roast weighs noticeably more than a scoop of dark roast.
- Leaving out the bloom when the beans are very fresh, which leaves dry pockets in the bed.

Cleaning
Rinse the dripper after each use and wash it properly once a week. Descale the kettle monthly if you live in a hard-water area.`,
        },
        {
          title: "Coffee corner",
          headingPath: "Brewing > Dialling in a new bag",
          body: `New beans arrived Monday. First brew at our usual setting finished in 2:10 and tasted sour, so I went three clicks finer: 3:05 and much sweeter. Keep 15 g to 250 g and the kettle at 94 °C. If the next bag is a dark roast, start two clicks coarser and drop the water to 90 °C.`,
        },
      ],
    },
    {
      id: "food.cast-iron-care",
      short: ["cast iron seasoning", "rusty cast iron skillet"],
      question: "Can I use soap on cast iron?",
      passages: [
        {
          title: "Cast iron skillet care",
          headingPath: null,
          body: `After cooking, wipe the skillet out while it's still warm, scrub off stuck bits with hot water and a stiff brush (a little dish soap is fine), then dry it on the hob for a minute. Rub in a few drops of oil with a cloth and heat until it just smokes. Never soak it or put it in the dishwasher.`,
        },
        {
          title: "Kitchen wiki",
          headingPath: "Kitchen > Re-seasoning a rusty pan",
          body: `The skillet from the holiday cottage came back with orange rust spots. It's fine: cast iron is very hard to ruin, and there's no need to replace it. Here's how to bring it back.

1. Scrub the rust off with steel wool and a little water until you see bare grey metal. Be thorough; new seasoning won't stick to rust.
2. Wash with warm soapy water, rinse, and dry immediately over a low heat.
3. Wipe a very thin layer of oil over every surface, inside, outside and the handle. Flaxseed oil, vegetable oil or lard all work. Then wipe it off again as though you'd put it on by mistake: too much oil turns sticky.
4. Put it upside down in the oven at 230-250 °C for an hour, with a sheet of foil on the shelf below to catch drips. Turn the oven off and let it cool inside.
5. Repeat steps 3 and 4 two or three more times for a dark, even finish.

Seasoning is just oil baked into a hard polymer layer, so it builds up with every use. Cooking something fatty, like bacon or shallow-fried potatoes, for the first few meals helps. Hold off on tomato sauces and vinegar until the surface is properly black and smooth, since acids strip a thin coating.`,
        },
      ],
    },
    {
      id: "sport.offside-rule",
      short: ["offside rule", "offside football"],
      question: "Can a player be offside from a throw-in?",
      passages: [
        {
          title: "Offside for touchline newcomers",
          headingPath: null,
          body: `Offside causes more touchline arguments than any other rule in junior football, so here is the short version.

A player is in an offside position if, at the moment a teammate plays the ball, any part of their head, body or feet is:
- in the opponents' half, and
- nearer to the opponents' goal line than both the ball and the second-last opponent.

The goalkeeper usually counts as one of those last two opponents. Arms and hands don't count, because you can't score with them. Level with the second-last opponent is onside.

Being in an offside position isn't an offence on its own. The referee only stops play if the player then gets involved: playing the ball, blocking a defender's view or movement, or gaining an advantage from a rebound off the post or the keeper.

Three restarts can never produce an offside: a goal kick, a throw-in and a corner kick.

What decides it is where the player was when the pass was made, not where they were when it arrived. That's why a winger who sprints past the defence after the pass is perfectly legal, and why the flag sometimes goes up for a player who looks onside by the time the ball reaches them.

The punishment is an indirect free kick to the defending team from where the offence happened.

Under-7 and under-8 small-sided games don't use offside at all in our league.`,
        },
        {
          title: "U12 coaching handbook",
          headingPath: "Coaching notes > Offside in practice",
          body: `These are the situations that come up most in our matches, with the call and the reason. Use them in the Tuesday session with the cones and bibs; walking through them slowly works better than any amount of talking.

1. Striker level with the last defender
The keeper is on the line and one defender is level with our striker when the pass is played. Onside. Level counts as onside, and the keeper is the other of the last two opponents.

2. Striker beyond the defender but behind the ball
Our midfielder carries the ball past the defence and cuts it back to a striker who was ahead of the defender but behind the ball. Onside: a player behind the ball can't be offside.

3. Standing offside but not involved
A winger is clearly offside on the far side when our number 9 shoots from distance and scores. If the winger didn't touch the ball, block the keeper's view or challenge for it, the goal stands. If the shot deflects off the winger, it's offside.

4. Rebound off the keeper
A shot is saved and the ball bounces to a striker who was offside when the shot was taken. Offside: the player gained an advantage from being there. A deliberate pass or clearance by a defender, on the other hand, resets the picture, and the striker is onside to collect it.

5. Coming back from an offside position
A striker in an offside position jogs back towards halfway and the ball is played to someone else. No offence. If the ball then reaches the striker later in the same move, what matters is where they were at the moment of that later pass.

6. Throw-in straight to a forward
Never offside from a throw-in, a corner or a goal kick, however far forward the receiver is. The next pass after that is judged normally.

7. Starting in our own half
A player who is in their own half when the ball is played can't be offside, even if they're past every defender a moment later. The halfway line itself counts as their own half.

Teaching tips
- Younger players learn it best as "stay level until the pass". Have them curve their runs along the line of the last defender and only burst forward when the passer's foot meets the ball.
- Put a coach on the far touchline holding a flag during small-sided games. Players start watching the line instinctively.
- Tell them why it exists: without offside, a team could park a forward next to the keeper all game.

Defending against it
We don't play an offside trap at this age. Stepping up as a line takes communication that most squads don't have yet, and a single mistimed step leaves a striker one-on-one with the keeper. Ask the defenders to hold a sensible line and recover goal-side instead.

For assistant referees
Volunteer assistants should stand level with the second-last defender, not the ball, and move with them the whole game. Raise the flag only after the attacker gets involved; a flag that goes up too early stops a game that might have carried on. If in doubt, keep the flag down: a goal can be talked about later, but a wrongly stopped attack can't be replayed.

Talking to referees
Offside is a matter of fact for the referee, not something to argue about. Coaches who shout at the officials over offside will be asked to step away from the touchline. Talk to your players about it afterwards instead.`,
        },
      ],
    },
    {
      id: "sport.chess-openings",
      short: ["chess opening repertoire", "sicilian defence"],
      question: "Which chess opening should I study first?",
      passages: [
        {
          title: "Building an opening repertoire",
          headingPath: null,
          body: `Most club players lose more games to tactics than to openings, so the aim of a repertoire is modest: reach a playable middlegame you understand, without spending hours memorising lines.

Pick one answer to each main question
As White you need one first move and a plan against the main replies. As Black you need one defence against 1.e4 and one against 1.d4; the rest (1.c4, 1.Nf3 and so on) can usually transpose into something you already know. That's three systems, not thirty.

Choosing a style
- If you enjoy sharp, tactical positions: 1.e4 with the Italian Game as White, and the Sicilian as Black against 1.e4.
- If you prefer slow manoeuvring and pawn structures: 1.d4 with the Queen's Gambit as White, and as Black the French Defence against 1.e4 and the Slav against 1.d4.
- If you want a low-maintenance setup: the London System as White, which uses the same development against almost anything.

Studying a new opening
1. Learn the ideas before the moves. For each opening, write down the typical pawn structure, where your pieces belong, the usual pawn breaks and the plan for each side.
2. Play through a handful of complete, annotated master games in that opening. Games show you what happens after move 15, which is where club games are decided.
3. Only then build a short tree of moves: your main line to about move 8-10, plus the two or three replies you actually meet over the board.
4. Play it in fast online games, then look up the position where you first felt lost. That's the next thing to study.
5. Keep your notes in one document per opening and update them after each tournament.

What not to do
- Don't switch openings after one bad loss. Give a new line at least twenty games.
- Don't memorise long lines you can't justify. If you can't say why a move is played, you'll be lost the moment your opponent deviates.
- Don't play gambits only for the trap. Club players fall for traps less often than videos suggest, and you're left a pawn down.

Our club repertoire sheet
For juniors moving into league chess we suggest:
- White: 1.e4, Italian Game (slow lines with c3 and d3)
- Black against 1.e4: 1...e5, meeting the Italian with solid development
- Black against 1.d4: Queen's Gambit Declined

It's not the sharpest repertoire, but every opening in it teaches sound principles: control the centre, develop knights before bishops, castle early, and connect the rooks.

Revising
Once a month, set up the key positions on a board without looking at your notes and play both sides against a clubmate for ten minutes each. If you keep forgetting a particular move order, it probably isn't important, or you don't yet understand the idea behind it. Writing yourself a short quiz of five key positions, with the plan for each side on the back, works well too, and it takes only a few minutes before a league match.

Engines
An engine is useful for checking a line after a game, not for building the repertoire. Its top choice is often a move no human would find or remember. Prefer the second- or third-best move if it leads to a position you understand.`,
        },
        {
          title: "Club wiki",
          headingPath: "Chess club > Openings > Study plan",
          body: `Openings study plan for the autumn: twenty minutes of openings per club night, no more. Pick one line from your repertoire sheet, play through two annotated games in it, then test it in three blitz games against a clubmate. Note the first position where you were unsure and bring it to the next club night.`,
        },
      ],
    },
    {
      id: "sport.marathon-training",
      short: ["marathon training schedule", "marathon taper"],
      question: "How long should my longest run be when training for a marathon?",
      passages: [
        {
          title: "Marathon group: week 1",
          headingPath: null,
          body: `Welcome to the 18-week plan! This week is easy: three runs of 5-8 km at a pace where you can chat in full sentences, plus one longer run of 12 km on Sunday. Don't worry about speed yet. Wear the shoes you'll race in, eat something before the long run, and log every session in the shared sheet.`,
        },
        {
          title: "Running club handbook",
          headingPath: "Marathon training > Long runs",
          body: `The weekly long run is the heart of marathon training. It teaches your body to burn fat, strengthens tendons and gets you used to hours on your feet.

How far
Build from about 12 km to a peak of 30-35 km, three to four weeks before race day. Most plans add 1.5-3 km a week and cut back every third or fourth week to recover. Going beyond 35 km adds more fatigue than fitness for most runners.

How fast
Slower than you think: 30-60 seconds per kilometre slower than your goal marathon pace. You should be able to talk throughout. In the second half of the plan, some long runs can finish with 5-8 km at goal pace.

Fuel and drink
Practise race-day fuelling on every long run over 90 minutes: a gel or a few sweets every 30-45 minutes, with water. This is the only way to find out what your stomach tolerates.

The taper
Over the last three weeks, cut weekly distance step by step to about half of your peak, while keeping a little goal-pace running. Feeling sluggish during the taper is normal.

Warning signs
A niggle that changes your stride, or that gets worse as you go, means stop and walk home. Better to miss one long run than six weeks of the plan.`,
        },
      ],
    },
    {
      id: "sport.tennis-serve",
      short: ["tennis serve toss", "kick serve tennis"],
      question: "Why is my tennis serve so inconsistent?",
      passages: [
        {
          title: "Serve clinic notes",
          headingPath: null,
          body: `Notes from Saturday's serve clinic.

Grip
Everyone switched to the continental grip, the one you'd use to hold a hammer. It feels awkward at first and the ball tends to go to the left, but it's the only grip that lets you add spin and pace later. Stop using the forehand grip for serving, even on second serves.

Stance
Front foot at about 45 degrees to the baseline, pointing roughly at the net post. Back foot parallel to the baseline. Weight starts on the back foot.

Toss
The biggest fault in the group. Hold the ball in your fingertips, not your palm, lift with a straight arm and let go at about head height. The ball should peak just above where your racket can reach, slightly in front and to the right of your head (for right-handers). If the toss is bad, catch it and start again; that's allowed.

Swing
Trophy position: tossing arm up, racket arm bent, elbow at shoulder height. Then drop the racket behind your back, reach up and hit up and out. Let the arm pronate naturally after contact.

Homework
Twenty tosses a day without hitting, letting the ball land on a racket placed on the ground in front of your front foot. Then ten serves aiming at a cone in each service box.`,
        },
        {
          title: "Coaching library",
          headingPath: "Tennis > Serve > Toss and rhythm",
          body: `The toss is the part of the serve everything else depends on. A good toss puts the ball in the same place every time, so the swing can stay the same every time. Most serving problems that look like swing problems, such as netting, hitting long or losing spin, start with a wandering toss. That's why we spend so long on it.

Where the ball should go
For a flat or slice first serve, the ball should rise to a point slightly higher than the tip of your racket at full stretch, in front of the baseline and just to the hitting side of your head. For a kick second serve, toss it a little further back, over your head or even slightly behind it, so you can brush up the back of the ball. A different toss for each serve is fine at advanced levels, but it tells the receiver what's coming, so we teach one toss for all serves first and adjust later.

How to release
- Hold the ball with your fingertips and thumb, like holding an egg, never in the palm.
- Start with the tossing arm low, near your front thigh.
- Lift with a straight arm, moving from the shoulder rather than flicking the wrist or bending the elbow.
- Open the fingers at about head height and keep the arm reaching up after the ball goes. That raised arm also helps you turn your shoulders.
- The ball should rise without spinning much. A ball that spins a lot was flicked.

Rhythm
Toss and racket arm move together: "down together, up together". Both arms drop, then the tossing arm rises as the racket arm swings back and up into the trophy position. Players who toss first and then start the swing usually end up rushing or waiting under the ball. Counting out loud helps: "one" as the arms drop, "two" at the trophy position, "three" at contact.

The legs
Bend the knees as the ball goes up and push up into the ball. The leg drive is where much of the pace comes from, and it lets you hit up rather than down, which keeps the ball over the net. Keep the head up until after contact; dropping it early pulls the ball into the net.

First and second serves
A first serve can take more risk: flatter, faster, aimed at the lines. A second serve has to go in, so it needs margin, which comes from spin, not from slowing the arm down. Swing just as fast on the second serve, with more brush on the ball and the toss further back. Pushing a slow second serve in is the most common habit we try to break in club players.

Faults to watch for
- Foot fault: touching the baseline or the court inside it with either foot before you hit the ball. Starting a few centimetres behind the line solves most of these.
- Double faults: often a toss drifting forward under pressure. Slow down, bounce the ball a set number of times and take a breath.
- Catching the toss is allowed in a match. Do it whenever the ball goes up badly, instead of hitting a poor toss.

Practice drills
1. Toss-only: twenty tosses with no swing, letting the ball drop onto a racket lying on the court a little in front of your front foot. Aim to hit the strings every time.
2. Wall marks: stand side-on to a wall and toss so the ball rises alongside a tape mark at your target height.
3. Half-pace serves: serve at half speed for five minutes, concentrating only on rhythm.
4. Targets: put a cone in each corner of the service box. Ten serves to each cone, first serves then second serves, recording how many land in.
5. Pressure games: play a set where each player gets one serve only. It sharpens the second serve quickly.`,
        },
      ],
    },
    {
      id: "money-law-work.tenancy-deposit",
      short: ["tenancy deposit return", "landlord deposit deductions"],
      question: "Can my landlord refuse to return my tenancy deposit?",
      passages: [
        {
          title: "Moving out: getting the deposit back",
          headingPath: null,
          body: `Our tenancy ends on the 30th, and the agreement says the landlord has to return the deposit, minus any agreed deductions, within a set time after we hand back the keys. Here's the plan for getting all of it back.

Before moving out
1. Find the check-in inventory. It lists the condition of every room when we moved in, with photos. Everything is judged against it, so read it room by room.
2. Read the cleaning clause in the agreement. Ours asks for the flat to be returned "in the same standard of cleanliness" as at the start, which in practice means a deep clean: oven, fridge, inside cupboards, windows, skirting boards, limescale in the bathroom.
3. Sort out small things ourselves: fill nail holes, replace blown bulbs, re-hang the wardrobe door. Don't paint walls unless the colour matches exactly; a patchy repaint can cost more than the original mark.
4. Book carpet cleaning only if the agreement requires it or the carpets are clearly stained.

On the last day
- Take dated photos and a short video of every room, inside cupboards and appliances, once the cleaning is done.
- Read the gas, electricity and water meters and photograph them.
- Return every set of keys and get a written receipt, even just an email confirming it.
- Give the landlord a forwarding address in writing.

Fair wear and tear
A landlord can charge for damage, unpaid rent, missing items and cleaning that falls below the check-in standard. They shouldn't charge for normal wear and tear: lightly worn carpets, faded curtains, small scuffs, loose door handles from years of use. The longer you've lived somewhere, the more wear is expected. Deductions should also be proportionate: a stained carpet that was already eight years old doesn't justify the cost of a brand-new one.

If deductions are proposed
Ask for an itemised list with the reason and cost for each item, plus evidence such as photos, quotes or invoices. Compare it with the check-in inventory and our own photos. Reply in writing, item by item, saying which deductions we accept and which we don't, and why.

Many places require deposits to be held in a government-approved protection scheme, and those schemes usually offer a free dispute service. If the landlord and tenant can't agree, either side can send in their evidence and an adjudicator decides how the money is split. It's worth checking whether that applies to our deposit; the landlord should have told us when we moved in. Where there's no scheme, the next step is usually a small claims process.

Keep a folder
All of this works much better with records. Put the tenancy agreement, the inventory, the move-out photos, the meter readings and every email about the deposit into one folder in the flat admin space, so whoever is talking to the landlord can find it quickly.

Timeline
- Two weeks before: confirm the move-out date with the landlord in writing and ask whether they'll do a check-out visit.
- One week before: deep clean begins; small repairs done.
- Moving day: final clean, photos, meter readings, keys handed over.
- After: chase in writing if the deposit hasn't arrived within the agreed period.`,
        },
        {
          title: "Flat admin",
          headingPath: "Flat admin > Deposit > Email to the landlord",
          body: `Hi, following up on the check-out visit on the 30th. You've proposed deducting £120 for carpet cleaning. The check-in inventory notes the lounge carpet as "worn, light staining", and our move-out photos show it in the same condition. We're happy to accept the £35 for the missing blind, but please return the rest of the deposit or send evidence for the carpet charge.`,
        },
      ],
    },
    {
      id: "money-law-work.income-tax-filing",
      short: ["income tax return", "tax deductions"],
      question: "What expenses can I deduct on my tax return?",
      passages: [
        {
          title: "Tax return checklist",
          headingPath: null,
          body: `Before sitting down to file:
- payslips or the end-of-year summary from each employer
- interest statements from every bank account
- receipts for work expenses that weren't reimbursed
- charity donation receipts
- pension contribution statements
- last year's return, for reference
File online before the deadline; late returns can carry a penalty even if no tax is owed.`,
        },
        {
          title: "Household finances",
          headingPath: "Household finances > Tax return > Deductions and reliefs",
          body: `Things we can usually claim against income tax, and where the evidence lives. Rules differ by country and change most years, so check the current guidance from the tax authority before relying on any of this.

Work expenses
- Professional body memberships and subscriptions that the job requires.
- Uniform washing, tools and equipment the employer doesn't provide or reimburse.
- Business mileage in your own car above what the employer pays back.
Keep receipts in the Taxes folder, one subfolder per year.

Working from home
If the employer requires home working (not just allows it), a flat-rate allowance for extra household costs is often available without itemising bills.

Pensions and charity
- Pension contributions may get tax relief at your marginal rate. If you pay into a personal pension and are a higher-rate taxpayer, you may need to claim the extra relief on the return.
- Donations to registered charities can reduce the tax you owe, or let the charity claim tax back. Note the date, amount and charity for each.

Side income
Income from freelance work, renting out a room or selling things you made counts and has to be declared above certain small thresholds. Expenses that were wholly for that work can be deducted from it.

Deadlines
Postal returns are due earlier than online ones. Set a reminder a month before the online deadline and file by then; it leaves time to chase a missing statement.`,
        },
      ],
    },
    {
      id: "money-law-work.parental-leave",
      short: ["parental leave policy", "paternity leave entitlement"],
      question: "How do I apply for parental leave from my employer?",
      passages: [
        {
          title: "Parental leave: how to apply",
          headingPath: null,
          body: `Short guide for anyone expecting a baby or adopting. The full rules are in the people handbook; this is the short version.

1. Tell us early. Let your team lead and the people team know at least 15 weeks before the due date or placement. Earlier is better for planning cover, but tell us when you're ready.
2. Check what you're entitled to. Primary carers get up to 26 weeks at full pay; secondary carers up to 12 weeks, which can be split into blocks within the first year. Use the leave calculator in the people portal to see your dates and pay.
3. Submit the form. In the portal, go to Time off, then Parental leave, and fill in your expected date, chosen start date and whether you'd like to split your leave. Attach the due-date confirmation or adoption matching certificate when you have it.
4. Get confirmation. The people team confirms your leave dates and pay in writing within two weeks. Your team lead will start a handover plan with you about a month before you go.
5. Stay in touch, or don't. Up to ten optional keeping-in-touch days are available. Otherwise we won't contact you while you're away.

Employees whose partner gives birth can also take two weeks of paid leave around the birth itself, separate from the above, with as little as a week's notice. And everyone gets paid time off for antenatal or adoption appointments.

Questions go to the people team inbox.`,
        },
        {
          title: "People handbook",
          headingPath: "People handbook > Parental leave > Planning your time off",
          body: `Parental leave is open to every employee who becomes a parent through birth, adoption or surrogacy, whatever their gender and however long they've been with us. This section covers how to plan the time, not the policy wording; the full policy is linked at the top of the handbook.

How much leave
- Primary carers: up to 26 weeks at full pay, plus up to 26 further weeks unpaid.
- Secondary carers: up to 12 weeks at full pay, which can be taken in one block or in up to three blocks within the first year.
- Adoptive parents get the same entitlement, starting from the placement date.
Any statutory payments you're entitled to are included in, not added to, the full-pay amount.

When to tell us
Let your team lead and the people team know at least 15 weeks before the expected due date or placement, or as soon as you can if that isn't possible. You don't have to share why you need the time before you're ready to; just tell us roughly when, and we'll keep it confidential.

Applying
Fill in the parental leave form in the people portal. It asks for:
1. The expected date of birth or placement.
2. The date you'd like your leave to start.
3. Whether you'll take it in one block or split it.
4. A copy of the official confirmation of the due date, or the matching certificate from the adoption agency. You can upload this later if you don't have it yet.
The people team will confirm your dates in writing within two weeks.

Changing your dates
Babies rarely arrive on the due date. If you need to move your start date, tell us at least four weeks ahead where you can; if the baby comes early, your leave simply starts the day after the birth. Your end date can be moved with eight weeks' notice.

Handing over your work
About a month before you go, agree a handover plan with your team lead:
- a list of ongoing work with a named owner for each item
- access to shared documents and inboxes moved to the people covering you
- an out-of-office message pointing to the right colleague
- any decisions that need to be made before you leave, written down with a deadline
Nobody expects you to check messages while you're away. If you'd like a monthly update, say so; otherwise we won't contact you except for something only you can answer.

Keeping-in-touch days
You can work up to ten paid keeping-in-touch days during your leave without ending it. They're optional on both sides, useful for an offsite, a planning session or easing back in. Agree each one with your team lead in advance and log it in the portal.

Coming back
Most people find a phased start easier: shorter weeks for the first month, building back to full time. Ask for this on the back-to-work form at least eight weeks before your planned date. You can also apply for a permanent change to your hours; flexible working requests are considered fairly and answered within a month.

Your job is protected while you're away. You'll come back to the same role or, if that genuinely isn't possible, a similar one on the same pay and terms. Any pay review or bonus that happens while you're on leave includes you.

Questions
The people team holds open office hours on Thursdays, and there's a parents' channel where colleagues share what worked for them.`,
        },
      ],
    },
    {
      id: "money-law-work.invoice-dispute",
      short: ["disputed invoice", "client invoice dispute"],
      question: "What should I do when a client refuses to pay an invoice?",
      passages: [
        {
          title: "When a client disputes an invoice",
          headingPath: null,
          body: `This is how the finance team handles an invoice a client won't pay in full. Most disputes are misunderstandings and are settled within a week if we respond quickly and calmly.

1. Log it the same day
As soon as a client questions an invoice, whether by email, on a call or by simply not paying, open a dispute record in the finance space with:
- the invoice number, amount and due date
- who raised it and what exactly they're disputing
- whether they're disputing the whole invoice or a few line items
Put the invoice on hold in the accounting system so automatic reminders stop. Nothing sours a conversation faster than a "final demand" landing mid-discussion.

2. Separate out what's undisputed
If only part of the invoice is in question, ask the client to pay the rest now. Offer to split the invoice into two if their process needs it: one for the agreed amount, one for the disputed part.

3. Gather the evidence
Before replying, collect:
- the signed contract or statement of work, and any change requests
- the purchase order, if the client issued one
- timesheets, delivery notes, sign-off emails or anything showing the work was done and accepted
- earlier invoices to the same client, to check we've billed consistently
Ask the project lead for their side of the story. Often the issue is a scope change that was agreed verbally and never written down.

4. Reply within two working days
Acknowledge the dispute, restate what you understand the problem to be, and say when you'll come back with an answer. Keep it factual. If we got something wrong, such as a duplicate line, the wrong rate or hours billed to the wrong project, say so plainly and send a corrected invoice or a credit note straight away.

5. Talk, then write it down
A short call usually resolves more than a long email thread. Afterwards, send a summary of what was agreed: amounts, dates, and who does what next. Any agreed reduction is issued as a credit note against the original invoice, never by editing the invoice itself.

6. When we can't agree
If the client still refuses after a call and we're confident the work was delivered as contracted:
- the account lead and the finance lead decide together whether to offer a goodwill discount, pursue the full amount, or pause further work
- we send a formal letter setting out the amount, the evidence and a final payment date
- after that, the case moves to the escalation route in the contract, which may be mediation or a debt collection service
We don't threaten legal action in the first reply, and we never pause work without telling the client in writing first.

Late payment
Our standard terms allow interest on late payments. We rarely charge it during a genuine dispute, but we do mention it once the dispute is settled and the client still hasn't paid.

Preventing the next one
Looking at why disputes happen, most trace back to the same few causes:
- vague scope in the proposal
- extra work begun on a nod in a meeting
- invoices that don't say what they're for
Every invoice should list the deliverables or hours it covers and the purchase order number. Change requests are confirmed by email before the work starts, and the project lead checks every invoice before it goes out.

Record the outcome in the dispute record and close it, so we can see over time which clients and which kinds of work cause the most disputes.`,
        },
        {
          title: "Finance templates",
          headingPath: "Finance > Invoice disputes > First reply template",
          body: `Hi [name], thanks for letting us know about your concerns with invoice [number]. I've put it on hold so you won't get automatic reminders while we look into it. Could you tell me which line items you're questioning? In the meantime, would you be able to pay the undisputed amount of [amount] by the original due date? I'll come back to you within two working days.`,
        },
      ],
    },
    {
      id: "health.kidney-stones",
      short: ["kidney stones symptoms", "kidney stones pain"],
      question: "When should I go to the doctor with kidney stones?",
      passages: [
        {
          title: "Kidney stones: when to get help",
          headingPath: null,
          body: `Kidney stones usually announce themselves with sudden, severe pain in the side or lower back that comes in waves and may move towards the groin. Get urgent medical help if the pain comes with a fever or shivering, if you can't keep fluids down, or if you can't pass urine. Otherwise, see a doctor soon to confirm what's going on.`,
        },
        {
          title: "Health notes",
          headingPath: "Health notes > Kidney stones > Symptoms and what helps",
          body: `Kidney stones are hard lumps of minerals and salts that form inside the kidneys. Small ones often pass out of the body in the urine without anyone knowing. Trouble starts when a stone moves into the tube between the kidney and the bladder and blocks it, which is why the pain can be so intense.

Typical symptoms
- Sudden, severe pain in the side or back, below the ribs, which can spread to the lower belly and groin. It comes in waves and often makes it impossible to sit still.
- Pain or burning when passing urine, and needing to go more often.
- Pink, red or brown urine, or cloudy, strong-smelling urine.
- Nausea and vomiting.

Get urgent help if there's also a high temperature or shivering, if the pain is so bad you can't cope, if you can't pass urine, or if you have only one kidney. A blocked kidney with an infection is an emergency.

What helps
How quickly a stone passes depends mostly on its size. For one small enough to pass, a doctor may suggest painkillers and drinking plenty of water, and sometimes a medicine that relaxes the tube so the stone passes more easily. You may be asked to strain your urine to catch the stone so it can be analysed. Larger stones can be broken up with shock waves or removed in a procedure.

Preventing more
Anyone who's had one stone has a good chance of another. The most useful habit is drinking enough to keep your urine pale all day. A doctor may also advise cutting back on salt or some foods, depending on what the stone was made of.`,
        },
      ],
    },
    {
      id: "health.sprained-ankle",
      short: ["sprained ankle", "ankle sprain swelling"],
      question: "Should I put ice on a sprained ankle?",
      passages: [
        {
          title: "Sprained ankle first aid",
          headingPath: null,
          body: `If someone goes over on their ankle:

1. Stop. Get them to sit down and take the weight off it. Don't try to walk it off.
2. Check how bad it is. Severe pain right over the bony bump on either side of the ankle, a foot that looks out of shape, numbness, or being unable to take four steps all need an X-ray to check for a fracture. Go to urgent care or a minor injuries unit.
3. Otherwise, start PRICE straight away:
   - Protect: no weight on it for now; use crutches if available.
   - Rest the ankle for the first 48 to 72 hours.
   - Ice: wrap a cold pack or frozen vegetables in a cloth and hold it on for up to 20 minutes, every two to three hours.
   - Compress: a snug elastic bandage, not so tight that the toes tingle or change colour.
   - Elevate: keep the foot up on cushions, above hip height, as much as possible.
4. Avoid heat, alcohol, jogging and massage for the first two to three days. They increase swelling.
5. Painkillers from a pharmacy can help; follow the label.

After a couple of days, start moving it gently as pain allows. Most mild sprains feel much better within a week or two, but keep doing balance exercises for several weeks so it doesn't go again.

The first aid box in the hall cupboard has two cold packs, an elastic bandage and an arm sling.`,
        },
        {
          title: "First aid notes",
          headingPath: "First aid notes > Ankle sprain > Recovery and getting moving again",
          body: `Most ankle sprains are a stretched or partly torn ligament on the outside of the ankle, from rolling the foot inwards. Mild ones settle in one to three weeks; more severe sprains can take six weeks or longer, and the ligament keeps strengthening for months after it stops hurting.

The first two to three days
The goal is to limit swelling and protect the joint.
- Rest: avoid walking on it more than you need to. Crutches help if putting weight on it hurts a lot.
- Ice: a bag of frozen peas wrapped in a tea towel, 15-20 minutes every two to three hours while you're awake. Never put ice straight on the skin.
- Compression: an elastic bandage, snug but not tight. Loosen it if your toes go numb, tingly or pale, and take it off to sleep.
- Elevation: keep the ankle above the level of your hip when sitting or lying down.
Over-the-counter painkillers can help; check the label or ask a pharmacist which suits you. Avoid hot baths, heat packs, alcohol and massage for the first couple of days, as they can increase swelling.

See a doctor or go to an urgent care service if:
- you can't put any weight on the foot, or can't take four steps
- there's tenderness right over the bony bumps on either side of the ankle or along the outer edge of the foot
- the ankle looks misshapen, or the foot is cold, numb or blue
- the pain and swelling aren't improving after a few days
These can be signs of a fracture or a more serious ligament injury that needs a different treatment.

Days 3 to 14: gentle movement
Once the worst swelling has gone down, movement helps healing more than rest does.
- Ankle circles and writing the alphabet in the air with your toes, a few times a day.
- Walking as normally as you can, heel then toe, even if slowly. Limping for weeks teaches bad habits.
- Calf stretches against a wall.
A little discomfort during exercises is fine; sharp pain or swelling that's worse the next morning means you've done too much.

Weeks 2 to 6: strength and balance
Sprained ankles are prone to giving way again, mostly because the sense of joint position is damaged along with the ligament. That's why balance work is the best protection.
- Stand on the injured leg for 30 seconds, building up to a minute. Then try it with your eyes closed, or on a folded towel.
- Heel raises on both feet, then on the injured side only.
- Resistance band exercises: pushing the foot down, up, in and out against the band.
- Side steps and gentle hopping once these are comfortable.

Getting back to sport
You're usually ready when you can hop on the injured leg without pain, jog in a straight line and change direction at speed. Many people find a brace or taping helps for the first few months back, especially for sports with jumping and turning. A physiotherapist can set out a plan if you play sport regularly, if the ankle keeps giving way, or if it's still painful after six weeks.

Keeping it from happening again
Keep doing the balance exercises a couple of times a week, warm up before sport, and choose shoes with good support for uneven ground.`,
        },
      ],
    },
    {
      id: "health.hay-fever",
      short: ["hay fever remedies", "pollen allergy tablets"],
      question: "Which hay fever antihistamines are non-drowsy?",
      passages: [
        {
          title: "Living with hay fever",
          headingPath: null,
          body: `Hay fever is an allergic reaction to pollen. When pollen lands in the nose, eyes or throat, the immune system treats it as a threat and releases histamine, which causes the familiar sneezing, runny or blocked nose, and itchy, watering eyes. It isn't caused by hay, and it doesn't usually cause a fever.

Which pollen, and when
- Tree pollen: late winter to late spring.
- Grass pollen, the most common trigger: late spring through summer.
- Weed pollen: summer into early autumn.
Noting which weeks are worst for you, and how bad they get, tells you which pollen to plan around.

Common symptoms
- sneezing and a runny or blocked nose
- itchy, red or watery eyes
- an itchy throat, mouth, nose or ears
- coughing, from mucus trickling down the back of the throat
- headache, tiredness and poor sleep
People with asthma may find their chest gets tight or wheezy on high-pollen days.

Keeping pollen at bay
You can't avoid pollen completely, but small habits add up:
- Check the pollen forecast, which most weather services publish, and plan outdoor exercise for when counts are lower. Counts tend to peak in the early morning and early evening on warm, dry, breezy days. Rain washes pollen out of the air.
- Put a thin layer of petroleum jelly around the nostrils to trap pollen.
- Wear wraparound sunglasses outside.
- Shower, wash your hair and change clothes after spending time outdoors.
- Keep windows and doors shut on high-count days, especially in the morning, and drive with the car windows closed.
- Dry laundry indoors when counts are high.
- Vacuum regularly, ideally with a HEPA filter, and dust with a damp cloth.
- Keep pets out of the bedroom if they spend time outdoors; pollen collects in their fur.
- Avoid mowing the lawn yourself, or wear a mask if you must.

Treatments from the pharmacy
Most people can control hay fever with over-the-counter treatments, and a pharmacist can help choose one:
- Antihistamine tablets or liquids relieve sneezing, itching and a runny nose. Newer types are much less likely to cause drowsiness than older ones.
- Steroid nasal sprays reduce inflammation in the nose and help with a blocked nose. They take a few days to work fully, so start them a couple of weeks before your usual bad patch and use them every day.
- Antihistamine or other allergy eye drops soothe itchy eyes.
- Saltwater nasal rinses can wash pollen out of the nose.
Read the label, particularly if you're pregnant or breastfeeding, have other conditions or take other medicines, or if the treatment is for a child.

When to see a doctor
You should speak to a doctor if symptoms don't improve with pharmacy treatments, if you're wheezing or short of breath, or if hay fever is affecting your sleep, work or studies. They can check whether it's hay fever or something else, offer stronger treatments and, for severe cases that don't respond, refer you to an allergy specialist, who may suggest immunotherapy: a course of gradually increasing doses of the allergen over several years.

At work
If you share an office, ask to move away from the desk by the open window during the worst weeks, and keep a box of tissues and your eye drops in your drawer. Hay fever can make concentrating hard; a short walk indoors or a glass of water often helps more than you'd expect.`,
        },
        {
          title: "Family health notes",
          headingPath: "Allergies > Hay fever > High-count days",
          body: `On high pollen days: take the antihistamine at breakfast, not when symptoms start; keep bedroom windows shut until evening; put the drying rack indoors; and do outdoor errands after rain. Eye drops live in the fridge door, because cold drops are more soothing. If sneezing keeps you up at night, mention it at the next appointment.`,
        },
      ],
    },
    {
      id: "health.tooth-filling",
      short: ["tooth filling", "numb after filling"],
      question: "How long is my mouth numb after a filling?",
      passages: [
        {
          title: "Dentist: filling on Thursday",
          headingPath: null,
          body: `Booked for a filling on the lower left molar, Thursday 9:30. The check-up found a small cavity between two teeth. Expect about 30-45 minutes. The injection numbs the area for a few hours afterwards, so avoid hot drinks and chewing on that side until feeling comes back. Bring the bank card; the treatment cost goes on the shared health budget.`,
        },
        {
          title: "Health notes",
          headingPath: "Health > Dental > What happens during a filling",
          body: `A filling repairs a tooth where decay has made a hole (a cavity). The appointment usually takes 20 minutes to an hour.

1. Numbing. The dentist dries the gum and may rub on a numbing gel, then gives a local anaesthetic injection. Within a few minutes the tooth, nearby gum and often half the lip and tongue feel numb. You'll still feel pressure, but it shouldn't hurt; raise a hand if it does.
2. Removing decay. A drill, and sometimes hand instruments, remove the decayed part and shape the hole so the filling stays in. It's noisy and there's a lot of water spray, but it's usually over in minutes.
3. Filling. Tooth-coloured resin goes on in layers, each hardened with a blue curing light. Amalgam, a silver-coloured metal mixture, is still used in some places for back teeth because it's hard-wearing.
4. Shaping. The dentist shapes and polishes the filling and checks your bite with a thin coloured strip.

Afterwards
- Numbness lasts two to four hours. Avoid hot drinks and chewing until it wears off so you don't burn or bite yourself.
- Some sensitivity to cold or pressure for a week or two is common.
- If the bite feels high, or pain gets worse rather than better after a few days, call the practice; a small adjustment usually sorts it.
Brushing twice a day with fluoride toothpaste, cutting down on sugary snacks between meals and regular check-ups help avoid the next one.`,
        },
      ],
    },
    {
      id: "nature-space.volcanoes",
      short: ["how volcanoes erupt", "volcano eruption"],
      question: "Why do volcanoes explode violently?",
      passages: [
        {
          title: "How volcanoes erupt",
          headingPath: null,
          body: `Deep beneath the surface, in the Earth's upper mantle and lower crust, rock partly melts to form magma. This happens in three main settings: where tectonic plates pull apart, as along mid-ocean ridges; where one plate sinks beneath another and releases water that lowers the melting point of the rock above; and over hot spots, plumes of hot mantle rising from deep within the Earth.

Because magma is less dense than the solid rock around it, it rises, collecting in magma chambers a few kilometres below the surface. As it rises and the pressure drops, gases dissolved in it, mostly water vapour, carbon dioxide and sulphur dioxide, come out of solution and form bubbles, the way a fizzy drink froths when the cap comes off.

An eruption happens when the pressure in the chamber is greater than the strength of the rock holding it in. Magma forces its way up through cracks and vents and reaches the surface as lava, ash or both. New magma from below, a build-up of gas, or a landslide removing weight from the top of the volcano can all set one off.

How violent the eruption is depends mainly on the magma. Runny basalt lets gas escape easily and tends to produce lava flows. Sticky, silica-rich magma traps gas until it bursts out explosively, shattering the magma into ash and pumice.

Volcanoes are classed as active if they've erupted in recent millennia and could do so again, dormant if they are quiet but expected to wake up, and extinct if they are not expected to erupt again.`,
        },
        {
          title: "Year 9 earth science",
          headingPath: "Earth science unit > Volcanoes > Types of eruption",
          body: `Why do some volcanoes ooze lava gently while others blow themselves apart? Mostly it comes down to two properties of the magma: how runny it is, and how much gas is dissolved in it.

Viscosity and gas
Magma low in silica, such as basalt, flows easily, a bit like warm syrup. Gas bubbles rise through it and escape without much fuss. Magma rich in silica, such as andesite and rhyolite, is stiff and sticky. Gas can't escape, so pressure builds until the magma shatters into fragments as it nears the surface. Water and carbon dioxide are the main gases; a magma can hold several per cent of water by weight while it's deep underground and under pressure, in the same way a sealed bottle of fizzy drink holds carbon dioxide.

Effusive eruptions
Runny, gas-poor magma produces effusive eruptions: lava fountains and long lava flows rather than explosions.
- Hawaiian-style eruptions build broad shield volcanoes with gentle slopes, made of thousands of thin lava flows stacked on top of each other.
- Fissure eruptions spill lava out of long cracks in the ground rather than a single vent. Over millions of years, some have covered areas the size of countries in layers of basalt.
- Lava flows rarely move faster than walking pace, so they destroy property but seldom cost lives.

Explosive eruptions
Viscous, gas-rich magma produces explosive eruptions.
- Strombolian eruptions hurl out bursts of glowing lava every few minutes, like a pan of thick porridge spitting.
- Vulcanian eruptions are short, violent blasts that clear a plugged vent.
- The largest eruptions send a column of gas and ash tens of kilometres up into the stratosphere, and ash can fall hundreds of kilometres downwind.
Stratovolcanoes, the classic steep cones, are made of alternating layers of lava and ash from eruptions like these.

Pyroclastic flows
The most dangerous hazard is a pyroclastic flow: an avalanche of hot gas, ash and rock that can race downhill at well over 100 km an hour at several hundred degrees. Nothing in its path survives, which is why exclusion zones around active volcanoes are taken seriously.

Other hazards
- Ash fall collapses roofs, contaminates water supplies and grounds aircraft.
- Lahars are mudflows of ash and water, often triggered by heavy rain or melting snow on the summit. They can travel far down river valleys.
- Volcanic gases, especially sulphur dioxide, can cause acid rain and, high in the atmosphere, cool the climate for a year or two.

Measuring size
Scientists rate eruptions on an explosivity scale from 0 to 8, based mostly on the volume of material erupted. Each step up is roughly ten times bigger than the last. Small eruptions happen somewhere on Earth every week; the largest happen only every few tens of thousands of years.

Warning signs
Before an eruption, magma moving upward usually causes swarms of small earthquakes, bulging of the ground and changes in the gases escaping from vents. Monitoring these gives communities days to weeks of warning in many cases, though predicting exactly when and how big an eruption will be remains difficult.

Activity for the lesson
Shake a bottle of fizzy water and open it slowly, then shake another and open it quickly. Compare this to runny and sticky magma. Then write two sentences on which eruption style each bottle represents.`,
        },
      ],
    },
    {
      id: "nature-space.bird-migration",
      short: ["bird migration navigation", "how birds navigate"],
      question: "How do migrating birds navigate so accurately?",
      passages: [
        {
          title: "How migrating birds find their way",
          headingPath: null,
          body: `Every autumn, billions of birds set off from their breeding grounds for winter quarters that may be thousands of kilometres away, and many come back the next spring to the same hedge or the same barn. Young birds often make their first journey alone, at night, without ever having seen the route. How they do it is one of the most studied questions in biology, and the answer is that they use several senses at once, cross-checking one against another.

An inherited programme
Experiments with caged birds show that young migrants know, from birth, roughly which direction to fly and for how long. As autumn nights lengthen, they become restless and hop towards the direction their population would migrate. Birds of the same species from different breeding areas orient in different directions, and hybrids between two populations pick an intermediate heading, which tells us the direction is genetic. This inherited "clock and compass" programme is enough to get a first-year bird to the right general area, though not to a particular spot.

The sun compass
Birds that fly by day use the sun. Because the sun moves across the sky, a bird has to combine the sun's place in the sky with an internal clock to work out direction. When researchers shift a bird's body clock by keeping it under artificial light, it predictably heads off in the wrong direction by an angle matching the time shift.

The star compass
Many songbirds migrate at night and steer by the stars. Rather than learning individual constellations, young birds learn the point around which the night sky rotates, which marks north. Birds raised under a planetarium sky that rotated around a different star took that star as north.

The magnetic sense
Birds can also sense the Earth's magnetic field, and the evidence for this is strong even though exactly how it works is still debated. They seem to detect the angle of the field lines relative to the ground rather than which way is north, telling them whether they're heading towards the pole or the equator. One leading idea involves light-sensitive molecules in the eye, meaning birds may literally see the field as a pattern overlaid on their vision. Another involves tiny magnetic mineral particles in the beak area.

Landmarks and smell
Closer to their destination, experienced birds use what they've learned: coastlines, mountain ranges, rivers and, for some, even motorways. Seabirds such as shearwaters appear to navigate over open ocean partly by smell, using the odours of plankton and land carried on the wind.

Calibrating the compasses
The different compasses don't always agree, for example when clouds hide the stars. Birds seem to recalibrate their magnetic compass against the sunset each evening, which is why the sky at dusk matters so much for nocturnal migrants.

Weather and fuel
Before setting off, many birds fatten up fast, and some small songbirds almost double their body weight. That fat fuels flights across deserts or seas that can last days without stopping. They wait for favourable winds and clear skies; a night with a tailwind after a spell of bad weather can bring huge numbers of birds through at once, which is what birdwatchers hope for.

Why it matters
Light pollution confuses night migrants, and collisions with lit buildings kill large numbers each year. Turning off unnecessary lights during peak migration nights is one of the simplest ways to help.`,
        },
        {
          title: "Birding log",
          headingPath: "Birding log > Autumn > Headland, early October",
          body: `Clear night with a light northerly, so we were on the headland at dawn. Steady movement of thrushes and finches coming in off the sea for the first two hours, plus a few chiffchaffs and goldcrests in the bushes by the car park. Swallows streaming south along the cliffs all morning. Wind turns westerly tomorrow, so probably a quieter day.`,
        },
      ],
    },
    {
      id: "nature-space.satellite-orbits",
      short: ["geostationary orbit", "LEO satellite altitude"],
      question: "Why do geostationary satellites hover over the equator?",
      passages: [
        {
          title: "Orbit cheat sheet",
          headingPath: null,
          body: `Low Earth orbit (LEO): roughly 160-2,000 km up, one lap every 90-120 minutes. Imaging, crewed stations, broadband constellations.
Medium Earth orbit: around 20,000 km. Navigation satellites.
Geostationary orbit (GEO): 35,786 km above the equator, one lap per day, so it hovers over one spot on the ground. Weather and broadcast satellites.`,
        },
        {
          title: "Space reading group",
          headingPath: "Space reading group > Orbits > Low orbit versus geostationary",
          body: `Why do some satellites race around the planet every hour and a half while others seem to hang still in the sky? It comes down to altitude. The closer a satellite is to Earth, the stronger gravity's pull and the faster it has to travel sideways to keep falling around the planet rather than into it.

Low Earth orbit
At 400 km, a satellite moves at about 7.7 km per second and circles the Earth 16 times a day. Being close is good for detailed imaging and for communications with short delays, but each satellite only sees a small patch of the ground and passes overhead for a few minutes at a time. Covering the whole planet takes a constellation of hundreds or thousands of satellites. There's still a trace of atmosphere at that height, so satellites slowly lose altitude and need occasional engine burns, or they re-enter and burn up within years.

Geostationary orbit
At 35,786 km above the equator, one orbit takes as long as the Earth takes to rotate once. A satellite there, moving in the same direction as the Earth spins, stays above the same point on the ground. Dishes can be pointed once and left alone, which is why it's used for television broadcasting and weather imaging. The downsides: signals take about a quarter of a second for the round trip, the view of polar regions is poor, and getting there needs much more energy.

In between
Navigation constellations sit in medium Earth orbit at around 20,000 km, a compromise between coverage and the number of satellites needed.`,
        },
      ],
    },
    {
      id: "nature-space.ocean-tides",
      short: ["ocean tides moon", "neap tides"],
      question: "Why are there two tides every day?",
      passages: [
        {
          title: "Why the tide comes in and goes out",
          headingPath: null,
          body: `Tides are the regular rise and fall of the sea, caused mainly by the Moon's gravity, with help from the Sun.

The Moon pulls on the whole Earth, but it pulls hardest on the side facing it and weakest on the far side. That difference stretches the oceans into two bulges: one under the Moon and one on the opposite side of the planet. As the Earth rotates through these bulges, most coastlines see two high tides and two low tides a day. Because the Moon is also moving along its orbit, the cycle takes about 24 hours and 50 minutes, so high tide arrives roughly 50 minutes later each day.

The Sun has the same effect at less than half the strength. When the Sun, Moon and Earth line up at new and full moon, the effects add together and the range is largest: spring tides. When they're at right angles, at the quarter moons, they partly cancel and the range is smallest: neap tides.

Real coasts complicate this neat picture. Continents get in the way of the bulges, so the water sloshes around ocean basins in huge rotating patterns. Some places get only one tide a day, some barely any, and funnel-shaped bays can amplify the range to well over ten metres. Weather adds its own effect: strong onshore winds and low air pressure can push the sea higher than predicted, which is when coastal flooding is most likely.

Tide tables are calculated from long records at each port, combining dozens of these astronomical cycles.`,
        },
        {
          title: "Coastal walks",
          headingPath: "Coastal walk planning > Tides > Reading a tide table",
          body: `The causeway walk and the cove beaches on our route are only safe around low water, so the tide decides our timings, not the weather or the pub. Read this before you plan a walk.

Why there are two tides a day
The Moon's gravity pulls on the ocean, raising a bulge of water on the side of the Earth facing it. A second bulge forms on the far side, where the Moon's pull is weakest and the water is effectively left behind. As the Earth turns, most coasts pass through both bulges each day, so we get two high tides and two low tides roughly every 24 hours and 50 minutes. The extra 50 minutes is because the Moon moves along its orbit while the Earth turns, so high water comes about 50 minutes later each day.

Springs and neaps
Twice a month, at new and full moon, the Sun and Moon line up and their pulls add together. Tides then rise higher and fall lower than usual: these are spring tides, which have nothing to do with the time of year. Halfway between, at the half moons, the Sun and Moon pull at right angles, and the range between high and low water is smallest: neap tides. On our stretch of coast the difference is dramatic. A spring range can be twice a neap range, and the causeway is only uncovered for long enough to cross on bigger tides.

Reading the table
A tide table lists, for each day, the times of high and low water and the height of each above a fixed reference level, called chart datum, which is roughly the lowest the tide normally falls. Things to check:
- The location. Times can differ by an hour or more between harbours a few kilometres apart. Use the station nearest the route.
- The time zone. Some tables are in standard time all year and you add an hour in summer. The header says which.
- The height. A low water of 0.3 m means much more beach is uncovered than one of 1.8 m.

The twelfths
The tide doesn't rise at a steady pace. A rough guide for the six hours between low and high water:
- 1st hour: 1/12 of the range
- 2nd hour: 2/12
- 3rd hour: 3/12
- 4th hour: 3/12
- 5th hour: 2/12
- 6th hour: 1/12
So the water comes in fastest in the middle two hours. On a 6 m spring range, that's 1.5 m an hour, fast enough to cut off a beach while you're looking at rock pools.

What else changes the tide
- Strong onshore winds pile water against the coast and can push high water above the predicted height.
- Low air pressure lets the sea rise a little; high pressure holds it down.
- The shape of the coast matters: funnel-shaped bays and estuaries amplify the range, and some rivers see a tidal bore, a wave that travels upstream on big spring tides.

Our safety rules
1. Plan to cross the causeway no later than two hours after low water, and be off it with an hour to spare.
2. Check the table the evening before and again in the morning, in case anything has changed with the weather.
3. Post the time of high water in the group chat so everyone knows when to be back.
4. If anyone gets cut off, don't try to wade or swim back. Go to the highest ground available and call the coastguard.

As a habit: if you can see the water creeping up the sand while you watch, it's time to head back.`,
        },
      ],
    },
    {
      id: "machines-software.database-indexes",
      short: ["database index", "SQL query optimisation"],
      question: "Why is my SQL query ignoring the index?",
      passages: [
        {
          title: "Why is this query slow?",
          headingPath: null,
          body: `A query that was fast last month and is slow now almost always means the table grew and the database had to start reading far more rows than it sends back. Indexes are usually the answer, but not always. Work through this page before adding one.

1. Look at the plan
Prefix the query with EXPLAIN ANALYZE and execute it against a copy of production data, not production itself, since ANALYZE really executes the statement. The output is a tree of steps. Read it from the most indented line outwards, and look for:
- Seq Scan on a large table: the database is reading every row.
- A big gap between estimated rows and actual rows: the planner's statistics are out of date or misleading.
- Sort or Hash steps that spill to disk.
- Nested Loop joins over many thousands of rows on the inner side.

2. Why an index helps
Without an index, finding the orders for one customer means checking every row in the orders table. A B-tree index keeps the values of one or more columns in sorted order, with pointers back to the rows, so the database can jump straight to the matching entries, the way you'd use the index at the back of a book. Lookups go from scanning millions of rows to reading a handful of pages.

3. Choosing the columns
- Index the columns in WHERE clauses and JOIN conditions of the queries that matter, not every column.
- For a multi-column index, order matters. An index on (customer_id, created_at) serves WHERE customer_id = ? and WHERE customer_id = ? ORDER BY created_at, but not a filter on created_at alone. Put equality filters first and ranges or sorts last.
- A covering index includes every column the query reads, so the database never has to visit the table at all (an index-only scan).
- A partial index, such as WHERE deleted_at IS NULL, stays small when queries only ever look at a subset.

4. When the index is there but isn't used
- Wrapping the column in a function: WHERE lower(email) = ? can't use a plain index on email. Index the expression instead.
- Type mismatches, such as comparing a text column to a number.
- Leading wildcards: LIKE '%@example.com' can't use a B-tree index.
- Low selectivity: if a filter matches a large share of the table, a sequential scan really is cheaper, and the planner is right to choose it.
- Stale statistics after a big import. Execute ANALYZE on the table and check the plan again.

5. What indexes cost
Every index makes inserts, updates and deletes slower, because each one has to be updated too, and each takes disk space and memory. Before adding one, check for an existing index it would duplicate. An index on (a, b) already serves queries on a alone. Periodically look for indexes that are never scanned and drop them.

6. Adding it safely
Creating an index normally locks the table against writes until it finishes, which on a big table can mean minutes of failed requests. Use the concurrent option your database offers, add it during a quiet period, and watch replication lag. Add the index in a schema change reviewed like any other code, not by hand on the server. Afterwards, the plan should show the new index being used.

7. If it's still slow
Not every slow query is an index problem. Check for:
- N+1 queries from the application issuing one query per row in a loop
- fetching far more rows or columns than the page shows
- lock contention with a long-lived transaction
- an undersized connection pool, which makes queries wait before they even start

Write down what you found and the before-and-after timings in the incident notes, so the next person investigating the same table starts from there.`,
        },
        {
          title: "Ops runbook",
          headingPath: "Runbook > Database > Before adding an index",
          body: `Before adding an index in production: confirm with EXPLAIN that the slow query really does a sequential scan, check that no existing index already covers the same leading columns, and estimate the build time on a staging copy. Create it concurrently, outside peak hours, and post the plan before and after in the incident channel.`,
        },
      ],
    },
    {
      id: "machines-software.bicycle-gears",
      short: ["bike gears skipping", "rear derailleur indexing"],
      question: "Why is my bike chain skipping gears?",
      passages: [
        {
          title: "Gear shifting tips",
          headingPath: null,
          body: `Shift before the climb, not halfway up it, and ease off the pedals for a moment as the chain moves. Avoid crossing the chain: big ring at the front with the biggest cog at the back, or small with small. If shifting is noisy or skips, turn the barrel adjuster by the rear derailleur a quarter turn at a time until it's quiet.`,
        },
        {
          title: "Workshop notes",
          headingPath: "Workshop notes > Rear derailleur > Adjusting the indexing",
          body: `If the chain hesitates, rattles or jumps between sprockets, the indexing is usually slightly out, often because a new cable has stretched. Sorting it out takes five minutes.

1. Put the bike in a stand or hang it so you can turn the pedals by hand.
2. Shift onto the smallest sprocket at the back. Check the chain sits directly under the upper jockey wheel. If it doesn't, the high limit screw needs setting first, so stop here and see the limit-screw page.
3. Shift onto the next larger sprocket while turning the pedals.
   - If it's slow to climb onto the next sprocket, or doesn't make it, turn the barrel adjuster anticlockwise (outward) a quarter turn to add cable tension.
   - If it jumps two sprockets or keeps trying to move up, turn it clockwise.
4. Repeat until a single click moves the chain cleanly one sprocket in both directions.
5. Shift through all the gears. It should move cleanly across the cassette with no clatter in any gear.
6. Take it for a short ride and fine-tune with the adjuster on the shifter or derailleur.

If adjusting doesn't help, check for a bent derailleur hanger (a common result of the bike falling on its right side), a frayed cable or dirty, sticky cable housing. A worn chain also shifts poorly; check its stretch with a chain checker and replace it before it wears out the cassette too.`,
        },
      ],
    },
    {
      id: "machines-software.password-managers",
      short: ["password manager", "password vault"],
      question: "How do password managers keep logins secure?",
      passages: [
        {
          title: "Using a password manager",
          headingPath: null,
          body: `A password manager stores all your logins in an encrypted vault and fills them in for you, so every account can have its own long, random password and you only need to remember one.

First steps
1. Install the app on your phone and laptop and add the browser extension.
2. Create a strong master password: four or five random words strung together works well. This is the one password you can't recover if you forget it, so write it down and keep it somewhere safe at home until it's memorised.
3. Turn on two-factor authentication for the vault.
4. Import the passwords your browser has saved, then delete them from the browser.

Day to day
- When you sign up somewhere new, let the manager generate the password and save it.
- When you log in, let the manager fill the form. If it doesn't offer to, look closely at the web address. It might be a fake site.
- Use the security report to find reused or weak passwords and change them a few at a time, starting with email and banking.
- Store notes like Wi-Fi codes, membership numbers and two-factor backup codes in the vault, not in a document on your desktop.

Sharing
Shared folders let a household share streaming, utility and Wi-Fi logins without sending passwords by message. Each person still has their own vault and master password.

If the manager is ever breached, a well-encrypted vault stays protected by your master password, which is another reason to make it long and unique.`,
        },
        {
          title: "IT handbook",
          headingPath: "IT handbook > Accounts > Choosing a password manager",
          body: `Everyone at the company uses a password manager for work accounts. This page covers how to choose one for personal use too, and how to set it up so it actually protects you.

Why bother
The biggest risk to your accounts isn't a clever attacker guessing your password. It's reusing one password across sites. When any one of those sites is breached, attackers try the same email and password everywhere else within hours. A password manager makes it practical to have a different, long, random password for every account, because you only have to remember one.

What to look for
- End-to-end encryption, so your vault is encrypted on your device and the provider can't read it.
- An independent security audit published in the last couple of years.
- Apps for every device you use, plus browser extensions that fill in logins only on the matching site. That matching protects you from phishing pages, because the manager won't offer your password on a look-alike address.
- Support for passkeys, which are replacing passwords on many sites.
- A way to share selected items with family or a partner without sharing the whole vault.
- A clear recovery process if you forget your master password, and the option to export your data if you switch.
Free tiers are often enough for one person. Avoid anything that stores passwords unencrypted or emails them to you.

Your master password
It's the one password you'll type, so it must be both strong and memorable. A passphrase of four or five random words is a good approach: long, easy to type, hard to guess. Don't use song lyrics, quotes or anything about yourself, and don't reuse it anywhere else. Write it on paper and keep it somewhere safe at home until you've memorised it.

Setting it up
1. Install the app and browser extension and create your vault with the master password.
2. Turn on two-factor authentication for the vault itself, ideally with an authenticator app or a hardware security key.
3. Save the recovery kit offline.
4. Import passwords saved in your browser, then delete them from the browser so there's only one copy.
5. Turn off the browser's own password saving to avoid confusion.

Cleaning up
Most managers include a health report that lists weak, reused and breached passwords. Work through it over a few weeks, starting with the accounts that matter most:
- your main email, which can reset everything else
- banking and other financial accounts
- your phone provider and cloud storage
- social media and shopping sites with saved cards
For each one, let the manager generate a new password of at least 16 characters and turn on two-factor authentication where it's offered.

Everyday habits
- Let the manager fill in passwords instead of copying them; if it doesn't offer to fill on a login page, check the address before typing anything.
- Save new accounts as you create them.
- Store two-factor backup codes and security questions in the vault too. Answer security questions with random words rather than true answers.
- Lock the vault automatically after a few minutes of inactivity on shared devices.

If something happens to you
Decide who should be able to get into your accounts if something happens to you. Many managers have an emergency-access feature that hands your vault to someone you name after a waiting period you choose.

Work accounts
Use the company vault for work credentials and your personal vault for everything else. Never store company passwords in a personal account; when you change jobs, you keep your personal vault and simply lose access to the work one.`,
        },
      ],
    },
    {
      id: "machines-software.printer-jams",
      short: ["printer paper jam", "paper jam tray 2"],
      question: "What should I do about a paper jam in the printer?",
      passages: [
        {
          title: "Clearing a printer jam",
          headingPath: null,
          body: `Paper jams are the most common problem with the office printers, and almost all of them can be cleared in a couple of minutes without calling anyone. Here's how, step by step.

Before you start
- Read the message on the printer's display. It usually names the area where the paper is stuck (for example, "Jam in tray 2" or "Open door B") and shows an animation of what to open.
- Don't switch the printer off in the middle of a job unless the display tells you to. Some models need the power on to release the rollers.
- If you've just been printing a lot, wait a few minutes. The fuser unit inside gets hot enough to burn, and there are warning labels where it is.

Clearing the jam
1. Open the doors or trays the display mentions. Look before you pull.
2. Hold the stuck sheet with both hands and pull it slowly and evenly in the direction the paper normally travels. Pulling backwards against the rollers can tear the sheet and damage the mechanism.
3. If the sheet tears, find every scrap. A torn corner hidden behind a roller will cause a new jam on the very next page. A torch helps.
4. Check the other common spots even if the display doesn't mention them: under the output tray, behind the rear access panel, and in the duplex unit that turns pages over for two-sided printing.
5. Close every door firmly until it clicks. A door that isn't fully shut often reads as a new jam.
6. The printer should resume the job by itself. If it doesn't, cancel the job and send it again.

Why it keeps jamming
If the same printer jams several times a day, the cause is usually the paper, not the machine.
- Damp paper curls and sticks together. Keep reams wrapped until you load them and store them flat, away from the window.
- Fan the stack before loading so the sheets separate, and square the edges by knocking them on the desk.
- Don't overfill trays. There's a line inside each one marking the maximum height.
- Set the paper guides so they touch the edges of the stack without bending it.
- Use the right weight. Heavy card, labels and envelopes go through the bypass tray, one type at a time, with the matching paper type selected in the print dialog.
- Never reload sheets that have already been through the printer once, or paper that's creased, torn or stapled.

Worn rollers
The rubber pickup rollers wear smooth over time and stop gripping, so the printer either grabs nothing (a "misfeed") or several sheets at once. A shiny or cracked roller needs replacing; facilities keeps spares for both office models. Wiping a roller with a lint-free cloth slightly dampened with water can buy some time.

When to stop and report it
Report the printer on the facilities board if:
- the same jam comes back after you've cleared it twice
- you see broken plastic, a bent part or anything stuck that you can't reach without tools
- the display shows an error code rather than a jam message
- there's a burning smell
Put a sign on the printer so the next person doesn't try to clear it again, and send your job to the printer on the other floor.

Please don't
- use scissors, knives or anything metal to dig out paper
- force a door that won't open
- print on paper with sticky notes or staples still attached
- try to repair the fuser yourself; it's a replaceable part, and a service visit is cheaper than a burn.`,
        },
        {
          title: "Office wiki",
          headingPath: "Office wiki > Second-floor printer > Tray 2 jams",
          body: `The second-floor printer jams in tray 2 when the paper guides are set loosely. If it jams there, slide the tray out fully, remove any crumpled sheets, push the side guide in until it touches the stack, and close the tray firmly. The thicker letterhead lives in tray 3 only; loading it in tray 2 will jam it every time.`,
        },
      ],
    },
    {
      id: "arts-history-language.jazz-voicings",
      short: ["rootless voicings", "jazz piano chords"],
      question: "How do jazz pianists voice a ii-V-I progression?",
      passages: [
        {
          title: "Voicings to practise this week",
          headingPath: null,
          body: `Practise the ii-V-I in C, F and B flat with shell voicings in the left hand: root and seventh, then root and third. Once that's comfortable, add the right hand on the ninth and fifth. Slow metronome, 60 bpm, swung eighths. Record yourself on the phone and listen back for smooth voice leading.`,
        },
        {
          title: "Piano lessons",
          headingPath: "Piano lessons > Voicings > Rootless voicings",
          body: `Once shell voicings feel automatic, move on to rootless voicings. In a band the bassist covers the root, so the pianist's left hand is free to play the more colourful notes: the third, seventh and extensions such as the ninth and thirteenth.

The two main shapes
- Type A: 3-5-7-9 from the bottom up. For Dm7 that's F-A-C-E.
- Type B: 7-9-3-5. For Dm7 that's C-E-F-A.
Alternate between them through a ii-V-I so the hand barely moves. In C: Dm7 as type A (F-A-C-E), G7 as type B (F-A-B-E, the fifth replaced by the thirteenth), Cmaj7 as type A (E-G-B-D). From chord to chord, no note moves more than a step. That smooth voice leading is what makes comping sound professional.

Where to put them
Keep the left hand roughly between the C below middle C and the G above it. Much lower and the close intervals turn muddy; much higher and they clash with the melody.

Practice routine
1. Play the ii-V-I in all twelve keys, starting with type A on the ii chord, then again starting with type B.
2. Say the chord names out loud as you play.
3. Use the shapes on a standard you know, voicing every chord from the lead sheet.
4. Add a walking bass line from a recording or play-along app and comp with the left hand only, varying the rhythm.

For minor ii-V-Is, use a half-diminished ii and an altered dominant: the flat ninth on the V gives that dark, tense sound before the resolution.`,
        },
      ],
    },
    {
      id: "arts-history-language.camera-exposure",
      short: ["aperture shutter iso", "exposure triangle"],
      question: "What aperture should I use for a portrait?",
      passages: [
        {
          title: "The exposure triangle",
          headingPath: null,
          body: `Exposure is the total amount of light that reaches the camera's sensor. Three settings control it, and they work as a trade-off: change one, and you have to change another to keep the same brightness.

- Aperture: the size of the hole in the lens, written as an f-number. A low number like f/2 lets in lots of light and blurs the background; a high number like f/11 lets in less and keeps more of the scene sharp.
- Shutter speed: how long the shutter stays open. A fast speed like 1/1000 s freezes a cyclist; a slow one like 1/15 s blurs motion and needs a steady hand or a tripod.
- ISO: how much the camera amplifies the signal. Low ISO gives the cleanest image; high ISO lets you shoot in dim light but adds grainy noise.

Photographers talk about stops. Each stop doubles or halves the light: going from f/4 to f/5.6, from 1/250 s to 1/500 s, or from ISO 800 to ISO 400 each removes one stop. So if you close the aperture by one stop for more depth of field, keep the shutter open one stop longer, or raise the ISO by one stop, to keep the same exposure.

A good habit is to pick the setting that matters most for the picture first. For a portrait that's usually aperture; for sport it's shutter speed; for a landscape on a tripod it's low ISO. Then let the other two follow.

In bright sun, try the "sunny 16" shortcut: at f/16, set the shutter speed to 1 over the ISO, such as 1/100 s at ISO 100.`,
        },
        {
          title: "Photography course",
          headingPath: "Photography course > Exposure > Choosing settings in the field",
          body: `Exposure is how much light reaches the sensor, and three settings control it: aperture, shutter speed and ISO. Each one also changes how the photo looks, which is why choosing between them is a creative decision, not just a technical one.

Aperture
The aperture is the adjustable hole in the lens. It's measured in f-numbers: f/2, f/2.8, f/4, f/5.6, f/8, f/11, f/16. Smaller numbers mean a wider hole and more light. Each full stop halves or doubles the light. Aperture also controls depth of field: wide apertures (f/1.8-f/2.8) blur the background behind a portrait, small ones (f/8-f/16) keep a landscape sharp from front to back.

Shutter speed
The shutter speed is how long the sensor is exposed: 1/1000 s, 1/250 s, 1/60 s, 1 s. Doubling the time doubles the light. Fast speeds freeze motion; slow speeds blur it. For handheld shots, keep the shutter speed at least as fast as 1 over the focal length, so 1/50 s with a 50 mm lens, and faster for moving subjects. Image stabilisation buys you a few stops for still subjects, but not for moving ones.

ISO
ISO sets how strongly the camera amplifies the signal from the sensor. Doubling the ISO from 100 to 200 lets you use half as much light, but higher values add noise: grain and blotchy colour, especially in the shadows. Modern cameras look clean up to ISO 3200 or 6400; check yours by shooting the same scene at each setting and comparing.

Choosing a starting point
Decide which effect matters most for the shot and set that first:
- Portrait: aperture first. Shoot wide open for a soft background, then set the shutter speed fast enough to avoid blur from hand shake, and raise ISO only if you have to.
- Sport and children: shutter speed first. Start at 1/500 s or faster. Open the aperture, then raise ISO.
- Landscape on a tripod: lowest ISO for the cleanest image, f/8-f/11 for sharpness, then whatever shutter speed gives the right brightness, even several seconds.
- Low-light interiors: wide aperture, the slowest shutter speed you can hold steady, and accept a higher ISO. A noisy sharp photo beats a clean blurred one.

Semi-automatic modes
In aperture priority (A or Av) you choose the aperture and the camera picks the shutter speed. In shutter priority (S or Tv) it's the other way round. Both work well with auto ISO and a minimum shutter speed set in the menu. Manual mode is worth it when the light is constant and you don't want the camera to change anything between frames, such as a studio portrait or a panorama.

Reading the meter and the histogram
The camera's meter aims to make every scene average grey, which is why snow comes out dull and a black cat looks washed out. Use exposure compensation: plus one stop for bright scenes, minus one for dark ones. After the shot, check the histogram rather than the screen, which looks brighter in a dim room. A graph squashed against the right edge means blown highlights that can't be recovered.

Practice for this week
Choose one subject and photograph it three times at the same overall brightness: once at f/2.8, once at f/8 and once at f/16, adjusting shutter speed and ISO to compensate. Bring the photos to the next session so we can compare depth of field and noise.`,
        },
      ],
    },
    {
      id: "arts-history-language.roman-roads",
      short: ["roman roads", "how romans built roads"],
      question: "How did the Romans construct roads?",
      passages: [
        {
          title: "How the Romans built their roads",
          headingPath: null,
          body: `At its height, Rome's road network ran to more than 80,000 km of paved highways, plus many times that in minor roads. Many of these routes are still followed by modern roads, and in places the original paving can still be walked on.

Why they built them
Roads were built first for the army. A legion could march 30 km or more a day on a good road, in any weather, and the network let Rome move troops quickly to trouble spots at the edges of the empire. Officials, messengers of the state post, traders and travellers used them too, and towns grew up along them.

Surveying the line
Roman surveyors laid out roads as straight as the ground allowed, using a groma, a vertical staff with crossed arms and hanging plumb lines, to sight straight lines between markers, often with fires lit on high points so the markers could be seen over long distances. Roads did bend, but usually at high points where the surveyors could see the next section, and they went around obstacles in a series of straight stretches rather than smooth curves. In hilly country they followed contours or cut terraces and zigzags to keep gradients gentle enough for carts.

Layers
Ancient writers and excavations describe a layered build, although the details varied with local materials and the importance of the road:
1. Workers dug a trench down to firm subsoil, sometimes a metre or more deep, and rammed the bottom.
2. Statumen: a foundation of large, rough stone blocks, sometimes set in clay.
3. Rudus: a layer of smaller broken stone, rubble or gravel mixed with lime mortar.
4. Nucleus: a finer layer of gravel, sand and lime, or crushed pottery, packed hard.
5. Summum dorsum or pavimentum: the surface. On major roads near towns this was close-fitting polygonal blocks of hard igneous stone, such as basalt; elsewhere it was compacted gravel.
Not every road had all these layers. Many rural roads were simply a raised bank of gravel and earth, the agger, which could be a metre or more above the surrounding ground and kept the surface dry.

Drainage
Water was the enemy of any road. The surface was cambered, higher in the middle than at the edges, so rain ran off into ditches on both sides. The raised agger lifted the road above flood level and helped it drain. Culverts carried streams underneath, and on steep slopes the surface could be cut with grooves so animals didn't slip.

Bridges and cuttings
Rivers were crossed by fords, timber bridges or arched bridges of stone and concrete, some of which are still in use. Engineers also cut through rock where necessary, and a few routes passed through tunnels.

Kerbs, milestones and facilities
Major roads had kerbs, footpaths along the sides and milestones every Roman mile (about 1.48 km), giving the distance to the next town. Along the main routes, the state maintained a system of stations: places to change horses every few miles, and inns with stabling roughly a day's travel apart.

Who did the work
Soldiers built many roads, especially in newly conquered provinces, where the army needed them first. Elsewhere, construction was paid for by the state, by local towns or by landowners along the route, and labour came from hired workers, local communities obliged to contribute, and enslaved people.

How long they lasted
Well-built paved roads lasted centuries with maintenance, which local towns were usually responsible for. After the western empire collapsed, maintenance stopped, stone was taken for other buildings and many roads gradually disappeared under fields. Their straight lines still show up in maps, field boundaries and parish borders today.

For the walk on Saturday
We'll follow a stretch of a minor Roman road where the agger is still visible as a low ridge crossing two fields. Everyone should bring boots; it's muddy after rain.`,
        },
        {
          title: "History club",
          headingPath: "History club > Roman roads > Milestones",
          body: `Roman milestones were stone columns, often over two metres tall, set beside major roads every thousand paces. Most carry an inscription giving the distance to a town and the name of the ruler or official who built or repaired that stretch, which makes them useful for dating roads. Our county museum has one in the entrance hall.`,
        },
      ],
    },
    {
      id: "arts-history-language.verb-conjugation",
      short: ["irregular verbs", "spanish verb conjugation"],
      question: "Which Spanish verbs are irregular in the present tense?",
      passages: [
        {
          title: "Spanish irregular verbs: my list",
          headingPath: null,
          body: `The ones I keep getting wrong, with the present-tense yo form: ser (soy), ir (voy), tener (tengo), hacer (hago), poner (pongo), salir (salgo), decir (digo), venir (vengo), saber (sé), conocer (conozco). Stem-changers: querer (quiero), poder (puedo), pedir (pido). Ten minutes of flashcards before breakfast.`,
        },
        {
          title: "Language learning",
          headingPath: "Language learning > Irregular verbs > Practice routine",
          body: `Irregular verbs are the most frequently used verbs in almost every language (to be, to have, to go, to do, to say), which is why they've stayed irregular: constant use keeps old forms alive. That's good news: there are relatively few of them, and you'll meet them constantly.

What's working for me
1. Learn them in families, not alphabetically. In Spanish, tener, venir, poner and salir all add a g in the yo form (tengo, vengo, pongo, salgo). Learning the pattern once covers several verbs.
2. Learn whole short phrases instead of tables: "I have to go", "we went yesterday", "they said no". Phrases stick, and they practise the verb in the form you'll actually need.
3. Spaced repetition flashcards, ten minutes a day. Front: "they had (tener, preterite)". Back: "tuvieron". The app brings back the ones I miss more often.
4. Say them out loud. Conjugating silently doesn't train the tongue.
5. One tense at a time. Present first, then the past tenses, then future and conditional, whose irregular stems are shared (tendr-, vendr-, pondr-, saldr-).
6. Write three sentences a day about my day using the week's verbs, and have them checked in the language exchange on Fridays.

Mistakes I've stopped making
- Mixing up ser and estar: ser for what something is, estar for state or location.
- Using the regular preterite for irregular verbs: "hací" instead of "hice".

Next month: the subjunctive, which reuses the yo form of the present, so all the irregular yo forms from step 1 are useful again.`,
        },
      ],
    },
    {
      id: "home-garden-craft.leaking-tap",
      short: ["dripping tap", "tap washer"],
      question: "How do I fix a dripping tap myself?",
      passages: [
        {
          title: "Fixing a dripping tap",
          headingPath: null,
          body: `A dripping tap wastes a surprising amount of water and is usually simple to sort: the washer or cartridge inside has worn out.

You'll need an adjustable spanner, a flat and a cross-head screwdriver, a replacement washer or cartridge, a cloth, and possibly some silicone grease.

1. Turn off the water supply, either at the isolating valve on the pipe under the sink or at the main stopcock.
2. Open the tap fully to drain any remaining water, and put the plug in so small parts can't fall down the plughole.
3. Remove the handle: prise off the decorative cap, undo the screw and lift it off.
4. Unscrew the valve body or cartridge with the spanner. Protect the chrome with a cloth.
5. If the tap has a rubber washer at the base of the valve, replace it with one of the same size. If it has a ceramic cartridge, take the old one to a plumbing supplier and buy an identical one.
6. Reassemble in reverse order, turn the water back on slowly and check for drips.

If it still drips, the seat inside the tap body may be damaged, or water may be coming from the spout seal rather than the valve. Drips from around the handle often mean a worn O-ring. Tap still dripping after a new washer and O-rings? It may be time to replace the whole tap.`,
        },
        {
          title: "House manual",
          headingPath: "Home maintenance > Plumbing > Replacing a washer or cartridge",
          body: `A tap that keeps dripping after you've turned it off firmly has a worn seal. Which seal depends on the type of tap. This page covers the two we have in the house: the old two-handle taps in the utility room and the single-lever mixer in the kitchen.

Work out the type
Here's how to tell:
- If the handle turns several times from off to fully on and gets stiffer as you close it, it's a compression tap with a rubber washer.
- If it turns only a quarter or half a turn, it has a ceramic disc cartridge.
- If it's a single lever that moves up and down for flow and side to side for temperature, it has a mixer cartridge.

Before you start
1. Turn off the water to the tap. There should be a small isolating valve on the pipe under the sink; a quarter turn with a flat screwdriver closes it. If there isn't one, close the main stopcock (under the kitchen sink in our house).
2. Open the tap to let the remaining water out and confirm it's off.
3. Put the plug in the sink so nothing small disappears down the drain, and lay a towel in the bowl to protect it.
4. Take a picture of each stage as you dismantle it. It makes reassembly much easier.

Replacing a washer (compression tap)
1. Prise off the decorative cap on the handle, undo the screw underneath and pull the handle off.
2. Undo the headgear nut with an adjustable spanner. Hold the tap body firmly with your other hand, or wrap it in a cloth and grip it with a second spanner, so you don't twist the pipework.
3. Lift out the headgear. The washer is at the bottom, held by a small nut or pressed onto a button.
4. Fit a new washer of the same size. Packs of assorted sizes are cheap; take the old one to the shop to match it if you're unsure.
5. Check the brass seat inside the tap body. If it's pitted or scored, a new washer will wear out quickly; a seat-reamer tool can smooth it.
6. Put a thin smear of silicone grease on the threads and reassemble in reverse order.

Replacing a ceramic disc cartridge
Ceramic cartridges don't have a washer to replace. Drips usually mean the discs are chipped or a rubber seal on the cartridge base is worn.
1. Remove the handle as above.
2. Unscrew the cartridge with a spanner, noting which way round it sits.
3. Take it to a plumbing supplier to match: cartridges are specific to hot or cold and to the number of splines on the spindle.
4. Clean any limescale from the tap body, fit the new cartridge and reassemble.

Mixer cartridges
On a single-lever mixer, the handle usually comes off after undoing a small grub screw hidden under a cap or behind the lever. Unscrew the retaining nut and lift the cartridge straight out. Again, buy an exact match; there are dozens of sizes.

Turning the water back on
Open the isolating valve slowly with the tap half open, so trapped air can escape, then close the tap and check for drips from the spout and leaks around the base. Tighten connections a little at a time if they weep; overtightening cracks ceramic parts.

Leaks elsewhere
- Water seeping from under the handle when the tap is on: the O-rings around the spindle or spout need replacing.
- Water collecting under the sink: check the flexible hoses and the compression joints, not the tap itself.
- Constant hissing or a dripping overflow somewhere else in the house: that's a cistern valve, not a tap.

When to call a plumber
If the stopcock won't turn, the valve under the sink is seized, or the tap body itself is cracked, stop and call someone. Forcing an old stopcock can break it, and then the water can't be turned off at all.`,
        },
      ],
    },
    {
      id: "home-garden-craft.beekeeping",
      short: ["hive inspection", "inspecting a beehive"],
      question: "What should I check on each hive inspection?",
      passages: [
        {
          title: "Hive inspection checklist",
          headingPath: null,
          body: `We inspect each hive roughly every seven to ten days from spring until late summer, on a warm, calm day between late morning and mid-afternoon when most foragers are out. Each inspection should be short: fifteen to twenty minutes with the roof off. Follow the same order every time so nothing gets missed.

Before you start
- Watch the entrance for a minute. Steady traffic, foragers coming in with full baskets on their back legs and no pile of dead bees at the entrance are good signs.
- Light the smoker and check it's producing cool, white smoke.
- Suit up properly: veil zipped, gloves on, trouser legs tucked in.
- Have the hive tool, a frame rest, a spare brood box and the record sheet ready.

Into the hive
Give a couple of gentle puffs of smoke at the entrance and wait a minute. Lift the roof, crack the crown board with the hive tool and puff a little smoke under it. Work from the side or back of the hive, never standing in front of the entrance. Move slowly; sudden movements and bumping the boxes upset the colony far more than smoke calms it.

Working through the frames
Take out the frame nearest the wall first to make space, then lift each frame vertically, holding it over the box so the queen can't fall onto the grass if she's on it. For each frame, look for:

1. Eggs. Tiny white rice-shaped specks standing upright in the bottom of cells. Eggs mean the queen was laying within the last three days, so you don't need to find her.
2. Brood pattern. Healthy capped brood is a solid, even patch of light brown cappings with few gaps. A spotty, patchy pattern, sunken or perforated cappings, or a bad smell need a closer look and possibly a call to the local bee inspector.
3. Larvae. Pearly white and curled in a C shape. Discoloured or twisted larvae are a warning sign.
4. Queen cells. Peanut-shaped cells hanging from the bottom edge of the frames often mean the colony is preparing to swarm. Cups with nothing in them are normal; cells with eggs or larvae inside need action the same day.
5. Stores. Capped honey in the top corners and bee bread around the brood. A colony going into winter needs plenty of capped stores, and in a cold, wet spell a colony can starve within days, even in summer.
6. Space. If the brood box is crowded and the bees are covering most frames, add a super before they're short of room, which is one of the main triggers for swarming.
7. Varroa and disease. Look for deformed wings on young bees and mites on drones or in uncapped brood. Monitor mite levels with a sticky board under the mesh floor or a mite count once a month.
8. Temper. Note whether the bees are calm, scurrying across the comb or following you. A colony that suddenly becomes defensive may have lost its queen.

Closing up
Put the frames back in the same order and orientation, push them together gently so you don't crush bees, and replace the crown board and roof. Check the entrance block is the right size: smaller in autumn, when wasps start robbing.

Record it
Fill in the record sheet straight after each hive, while it's fresh: date, weather, temper, eggs seen (yes or no), queen seen, number of brood frames, stores, queen cells, space added, varroa count and any treatment. Comparing records week by week shows trends that are impossible to spot from a single visit.

Safety
Anyone joining an inspection must tell us beforehand if they have ever had a severe reaction to a sting. Keep a phone with you and don't inspect alone if you're new. If you're stung, scrape the sting out sideways with a fingernail or the hive tool rather than squeezing it.`,
        },
        {
          title: "Apiary log",
          headingPath: "Apiary log > Hive 2 > Inspection notes",
          body: `Warm and still, 21 °C. Calm colony, eggs and young larvae on four frames, so the queen is laying well. Seven frames of brood, two of capped stores. Found three queen cups along the bottom bars, all empty; knocked them down and will check again in seven days. Added a second super because the bees were covering every frame.`,
        },
      ],
    },
    {
      id: "home-garden-craft.knitting",
      short: ["casting on knitting", "knit purl stitch"],
      question: "What stitch should I use for my first scarf?",
      passages: [
        {
          title: "Knitting: first steps",
          headingPath: null,
          body: `Start with a ball of smooth, light-coloured aran-weight yarn and 5 mm needles; dark or fluffy yarn hides your stitches. Begin by casting on 20 stitches with the long-tail method and knit every row (garter stitch) until the piece is square. Count your stitches at the end of each row: a sudden 21 means you've wrapped an extra loop. A garter-stitch scarf makes a good first project.`,
        },
        {
          title: "Craft group",
          headingPath: "Craft group > Knitting basics > Casting on",
          body: `Casting on puts the first row of loops onto the needle. There are dozens of methods; these two cover almost everything.

Long-tail method
Stretchy and neat, and it counts as your first row.
1. Pull out a tail about three times the width of the piece you're making (roughly 2.5 cm per stitch for medium yarn) and tie a slip knot. Put it on the right needle.
2. Hold the needle in your right hand. In your left, drape the tail over your thumb and the working yarn over your forefinger, holding both ends in your palm so the yarn makes a V.
3. Take the needle up through the loop on your thumb, over and behind the yarn on your finger, and back down through the thumb loop.
4. Let the thumb loop drop and gently pull both strands to snug the new stitch. Not too tight: the stitches should slide along the needle easily.
Repeat until you have the number you need. Coming up short of tail before the end is everyone's first lesson, so be generous.

Knitted method
Easier to learn and good for adding stitches mid-row, but looser at the edge.
1. Make a slip knot on the left needle.
2. Knit into it as for a normal knit stitch, but don't drop the old loop. Instead, put the new loop back on the left needle.
3. Keep knitting into the last loop you made.

Next time we'll cover the knit and purl stitches properly and how to read a simple pattern. Bring the square you're working on.`,
        },
      ],
    },
    {
      id: "home-garden-craft.composting",
      short: ["compost heap", "greens and browns compost"],
      question: "What can go in a compost bin?",
      passages: [
        {
          title: "Compost heap basics",
          headingPath: null,
          body: `A compost heap turns garden and kitchen waste into a dark, crumbly soil improver, and needs very little effort if you keep a rough balance of materials.

What to put in
- Greens (wet, nitrogen-rich): grass cuttings, fruit and vegetable peelings, used tea leaves, young weeds and soft plant trimmings.
- Browns (dry, carbon-rich): autumn leaves, shredded cardboard, egg boxes, straw, small twigs, sawdust from untreated wood.
Aim for roughly half and half by volume. If in doubt, add more browns.

What to keep out
Meat, fish, dairy, cooked food, cat and dog waste, diseased plants and the roots of perennial weeds.

Building it
- Choose a level, well-drained spot on bare soil, partly shaded.
- Start with a layer of twigs for airflow, then add greens and browns in thin alternating layers, or mix them as you go.
- Keep it as damp as a wrung-out sponge. Water it in dry weather and cover it in heavy rain.

Turning
How often you turn it mostly decides how fast it's ready. Turning the heap with a fork every few weeks lets air in, speeds things up and mixes dry edges into the warm middle. An unturned heap still rots down, just more slowly: allow a year rather than a few months.

Using it
Compost is ready when it's dark, crumbly and smells earthy, with little sign of the original ingredients. Spread it on beds as a mulch or dig it into the soil before planting. Anything still lumpy goes back into the new heap.`,
        },
        {
          title: "Allotment notes",
          headingPath: "Allotment notes > Compost > Greens, browns and turning",
          body: `A compost heap is a population of microbes, fungi and small creatures, and the gardener's job is to give them a balanced diet, keep them damp and give them air. Get those three right and a heap turns into dark, crumbly compost in a few months; get them wrong and it either sits there unchanged or turns into a slimy, smelly mess.

Greens and browns
Everything that goes in counts as either green or brown.
- Greens are rich in nitrogen, usually moist and soft: grass cuttings, vegetable peelings, fruit scraps, used tea leaves, fresh weeds without seed heads, young hedge trimmings, and manure from plant-eating animals.
- Browns are rich in carbon, usually dry and tough: dry leaves, straw, shredded cardboard and egg boxes, woody prunings, sawdust from untreated wood, and old plant stems.
A good working mix is roughly equal volumes of each, or a little more brown than green. Weight isn't a useful guide, because greens are much heavier.

Signs the mix is off
- Wet, slimy, smells of ammonia or rotting: too much green. Mix in torn cardboard or dry leaves and turn the heap.
- Dry, nothing happening, the same twigs you put in last year: too much brown, too little moisture, or both. Add grass cuttings or fresh green material and water it.
- Flies around the bin: food scraps on the surface. Bury them in the middle and cover with a layer of browns.

What stays out
Meat, fish, dairy and cooked food attract rats. Keep out cat and dog litter, diseased plants, perennial weed roots like bindweed and couch grass unless you drown them first, and anything treated with weedkiller. Coal ash is harmful; a little wood ash is fine.

Moisture
The heap should be about as damp as a wrung-out sponge. In a dry summer, water it every week or two. In a wet winter, keep the lid on or cover an open heap with old carpet.

Air and turning
The microbes that make good compost quickly need oxygen. Without it, slower anaerobic ones take over and the smell changes from earthy to sour.
- Build the heap on bare soil so worms can move in.
- Put a layer of twiggy material at the base for airflow.
- Chop or shred large items; small pieces break down faster.
- Turn the heap every few weeks: fork the outside into the middle and the bottom to the top, moving everything into the empty bay next door. Each turn adds air and gives the heap a fresh burst of heat, which is why turned heaps finish sooner.

Heat
A well-mixed heap of at least a cubic metre can reach 50-60 °C in the middle within a week of building it, which speeds things up and kills many weed seeds. Push a long thermometer or your gloved arm into the centre to check. Smaller bins rarely get that hot; they still make good compost, just more slowly, over six to twelve months.

When it's ready
Finished compost is dark brown, crumbly and smells like woodland soil. You shouldn't be able to recognise what went in, except perhaps for eggshells and the odd woody stick. Sieve out the lumps and put them back in the new heap. Use it as a mulch around fruit bushes and in the veg beds in spring, or mix it with soil for potting.

Our bays
Bay 1 takes new material, bay 2 is cooking, bay 3 is ready to use. Please add to bay 1 only, and log a turn on the shed noticeboard when you do one.`,
        },
      ],
    },
  ],
};
