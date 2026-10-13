-- The string ids of Skippy's own game lines: the 74 distinct lines of the four mq007 scenes (gun_found, skippy_reactions,
-- skippy_about_killing, skippy_return) and his 2 cameo lines in delamain_default.scene, 76 in all ("New magazine detected.",
-- "Provocation. ...", the hologram talk). init.lua hides only lines in this list or whose speaker is named Skippy (or the key
-- LocKey#46444) when the player's "Replace the game's own lines" is on; any other line, named or not, is never touched.
--
-- Source: scene-lines.jsonl of the repo's scene index (the speaker_tag/speaker "skippy" rows of the live, not versions\, scene
-- paths; docs/addons/SKIPPY_RESEARCH.md section 1.4), sid = the line's decimal string id. As decimal strings: the ids are
-- larger than a Lua number can hold exactly. Unverified in the game: that the CRUID the subtitle hook sees (line.id.hash) is
-- this string id. If it is not, nothing here matches and the name rule alone applies (the log says so).
return {
    ['1851824651336962048'] = true,   -- mq007_01_gun_found: New fingerprints detected.
    ['1851830037846708224'] = true,   -- mq007_01_gun_found: Increasing volume by 33 percent. New fingerprints de
    ['1851834306507329536'] = true,   -- mq007_01_gun_found: Checking memory... Resources available - 100 percent
    ['1851835534045892608'] = true,   -- mq007_01_gun_found: Increasing volume by sixty-six percent. Name...
    ['1851836695817768960'] = true,   -- mq007_01_gun_found: User inquiry. Technical specifications. HJKE-11 smar
    ['1851837536373067776'] = true,   -- mq007_01_gun_found: Possible cause. Theft. Original owner - no data.
    ['1851838599696240640'] = true,   -- mq007_01_gun_found: Suggested solution. None.
    ['1851881179716800512'] = true,   -- mq007_01_gun_found: No.
    ['1851883329364709376'] = true,   -- mq007_01_gun_found: Increasing volume by 300 percent. NOOOOO!
    ['1851885352428523520'] = true,   -- mq007_01_gun_found: Running system diagnostics. Testing will take approx
    ['1851907166064103424'] = true,   -- mq007_01_gun_found: Primary feature - automated targeting. In case of cr
    ['1851909335374909440'] = true,   -- mq007_01_gun_found: Adjusting settings...
    ['1853060652847878144'] = true,   -- mq007_02_skippy_reactions: Provocation. Taste my lead, bitch!
    ['1853061748232310788'] = true,   -- mq007_02_skippy_reactions: Provocation. What now, you piece of filth?!
    ['1853061947679854592'] = true,   -- mq007_02_skippy_reactions: Provocation. I'ma tear you to shreds, scopsucker!
    ['1853061947696631812'] = true,   -- mq007_02_skippy_reactions: Provocation. You done messed with the wrong woman!
    ['1853062014503505924'] = true,   -- mq007_02_skippy_reactions: Provocation. Kiss my juicy - beeep!
    ['1853063572972654596'] = true,   -- mq007_02_skippy_reactions: Fun fact. The human body holds between five and seve
    ['1853063573022986240'] = true,   -- mq007_02_skippy_reactions: Fun fact. The vast majority of murders are committed
    ['1853063573039763460'] = true,   -- mq007_02_skippy_reactions: Fun fact. Bloodstains can be removed using one easy 
    ['1853063573056540676'] = true,   -- mq007_02_skippy_reactions: Fun fact. The human brain remains active for up to s
    ['1853104067417493504'] = true,   -- mq007_02_skippy_reactions: Error - premature discharge. I'm sorry, this never h
    ['1853104698928680964'] = true,   -- mq007_02_skippy_reactions: Reason for firing - unknown.
    ['1853104735553343492'] = true,   -- mq007_02_skippy_reactions: Are you happy with the autonomous shooting function?
    ['1853105826441482240'] = true,   -- mq007_02_skippy_reactions: A delay has occurred. Possible cause - power surge. 
    ['1853105826458259460'] = true,   -- mq007_02_skippy_reactions: Installing update. This may take several minutes...
    ['1853105826475036676'] = true,   -- mq007_02_skippy_reactions: Bum bum be-dum bum bum be-dum bum...
    ['1853117853775974404'] = true,   -- mq007_02_skippy_reactions: Mmm, yeah! Don't stop!
    ['1853117853792751620'] = true,   -- mq007_02_skippy_reactions: New magazine detected. Message to user. Thanks, choo
    ['1853117853809528836'] = true,   -- mq007_02_skippy_reactions: Is there no end to this madness?!
    ['1853119850667331584'] = true,   -- mq007_03_skippy_about_killing: Hello user! I have prepared a usage data report for 
    ['1853123167187390464'] = true,   -- mq007_03_skippy_about_killing: User! I have assisted you in killing over fifty peop
    ['1853123373194825732'] = true,   -- mq007_03_skippy_about_killing: User! I have assisted you in maiming over fifty peop
    ['1853124124528889856'] = true,   -- mq007_03_skippy_about_killing: Stone Cold Killer mode has been deactivated. From th
    ['1853129923808481280'] = true,   -- mq007_03_skippy_about_killing: Opening Frequently Asked Questions. Item - "Why can'
    ['1853131213254971392'] = true,   -- mq007_03_skippy_about_killing: Answer - "The fuck is wrong with you? Please go see 
    ['1853132143652261888'] = true,   -- mq007_03_skippy_about_killing: Checking now... Bum bum be-dum bum bum...
    ['1853132854268022784'] = true,   -- mq007_03_skippy_about_killing: I'm so glad I could be of assistance!
    ['1853136590470139904'] = true,   -- mq007_03_skippy_about_killing: To help me improve your experience, please answer th
    ['1853144655848296448'] = true,   -- mq007_03_skippy_about_killing: But shooting out kneecaps is all right. Understood.
    ['1853146939042844672'] = true,   -- mq007_03_skippy_about_killing: Thank you. Initiating Stone Cold Killer mode. I will
    ['1853175403468836864'] = true,   -- mq007_04_skippy_return: User! I have an important message for you!
    ['1853181683315003392'] = true,   -- mq007_04_skippy_return: While running a routine diagnostic check, I discover
    ['1853182565746233344'] = true,   -- mq007_04_skippy_return: Name. Regina Jones.
    ['1853271584932909056'] = true,   -- mq007_04_skippy_return: You are the best user I know!
    ['1853272962107461632'] = true,   -- mq007_04_skippy_return: Increasing volume by 300 percent. TAKE ME BACK TO MY
    ['1853289713520103444'] = true,   -- mq007_04_skippy_return: Performance - 82 percent. Memory - damaged. Mode - P
    ['1853289713536880652'] = true,   -- mq007_04_skippy_return: Please set pistol name.
    ['1853290501277503492'] = true,   -- mq007_04_skippy_return: Performance - 82 percent. Memory - damaged. Mode - S
    ['1853436028560363520'] = true,   -- mq007_01_gun_found: Please choose one of two operating modes. First mode
    ['1864759790736297984'] = true,   -- mq007_01_gun_found: Name. Skippy.
    ['1864775203394211840'] = true,   -- mq007_01_gun_found: Understood. Hearing within norm. Possible issue - lo
    ['1864783066556583936'] = true,   -- mq007_01_gun_found: Processing request... No objections found.
    ['1864786060970872832'] = true,   -- mq007_01_gun_found: Administrator rights are needed to complete that act
    ['1864788820604801024'] = true,   -- mq007_01_gun_found: Bum bum be-dum bum bum be-dum bum...
    ['1864793857678692352'] = true,   -- mq007_01_gun_found: I'm making the wait more pleasant with a soothing me
    ['1864794534672912384'] = true,   -- mq007_01_gun_found: Bum bum be-dum bum bum be-dum bum...
    ['1864795319980838912'] = true,   -- mq007_01_gun_found: Test successfully completed. The program "Skippy v0.
    ['1864810409308246016'] = true,   -- mq007_01_gun_found: Second mode. Stone Cold Killer. I will aim exclusive
    ['1864815275573301248'] = true,   -- mq007_01_gun_found: Selected mode - Stone Cold Killer. Happy slaughterin
    ['1864817097981612032'] = true,   -- mq007_01_gun_found: Bum bum be-dum bum bum be-dum bum...
    ['1864821409893896192'] = true,   -- mq007_01_gun_found: Selected mode - Puppy-Loving Pacifist. Enjoy permane
    ['1864839337909473280'] = true,   -- mq007_02_skippy_reactions: Fun fact. According to traditional Christian doctrin
    ['1864859557592092672'] = true,   -- mq007_03_skippy_about_killing: Please say anything to continue.
    ['1864860237438439424'] = true,   -- mq007_03_skippy_about_killing: It looks like you're trying to be funny. Automated r
    ['1864886378907881472'] = true,   -- mq007_03_skippy_about_killing: Answer found - no. Permission denied.
    ['1864902673292382208'] = true,   -- mq007_03_skippy_about_killing: Why do you prefer to maim rather than kill your enem
    ['1864915126801715200'] = true,   -- mq007_04_skippy_return: Say anything to continue.
    ['1864916787980980224'] = true,   -- mq007_04_skippy_return: Automated response. Ha ha ha! The joke gets funnier 
    ['1864917057557286912'] = true,   -- mq007_04_skippy_return: It looks like you're trying to be funny. Automated r
    ['1864920224491687936'] = true,   -- mq007_04_skippy_return: User. Please return me to my real owner. Thank you i
    ['1864923598490488832'] = true,   -- mq007_04_skippy_return: Bad user! Bad user!
    ['1864926761750679552'] = true,   -- mq007_04_skippy_return: Fun fact. There is a 92 percent probability Regina J
    ['1864959131275022336'] = true,   -- mq007_04_skippy_return: My name is Daisy.
    ['1999863927946780672'] = true,   -- delamain_default: Why, thank you!
    ['2000003836386238464'] = true,   -- delamain_default: Fun fact. Women account for 44 percent of road rage 
}
