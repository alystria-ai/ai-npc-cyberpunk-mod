// Character bonds (docs/RELATIONSHIPS_AND_QUESTS.md 3.2): per named character, the journal paths of the quests V does with them and what each is worth
// to the bond once finished (succeeded or failed). The weights of a character add up to 350 (a whole arc is Close friend). `active` lists the path
// prefixes of that character's own quest lines: while a quest under one of them is active, no story pack of the character starts or moves (section 8).
// Paths come from research/cyberpunk/quest-premises.json, the paths the quest briefings were checked against on the owner's save.
// Path prefixes of the end of the story (after the point of no return, and the Phantom Liberty finale): while a quest under one of them is active, no
// pack starts or moves. The q116 and ep1 q306/q307 prefixes are from the quest naming, not checked against a save.
export const BOND_ARCS = {
  "version": 1,
  "arcs": {
    "judy-alvarez": {
      "quests": {
        "quests/main_quest/act_01/q105_dollhouse": 30,
        "quests/main_quest/act_01/q105_02_jigjig": 30,
        "quests/main_quest/act_01/q105_03_braindance_studio": 30,
        "quests/main_quest/act_01/q105_04_judys": 40,
        "quests/side_quest/sq026_01_suicide": 40,
        "quests/side_quest/sq026_02_maiko": 40,
        "quests/side_quest/sq026_03_pizza": 40,
        "quests/side_quest/sq026_04_hiromi": 50,
        "quests/side_quest/sq030_judy_romance": 50
      },
      "active": [
        "quests/main_quest/act_01/q105",
        "quests/side_quest/sq026",
        "quests/side_quest/sq030"
      ]
    },
    "panam-palmer": {
      "quests": {
        "quests/main_quest/act_01/q104_01_sabotage": 50,
        "quests/main_quest/act_01/q104_02_av_chase": 50,
        "quests/side_quest/sq004_riders_on_the_storm": 70,
        "quests/side_quest/sq027_01_basilisk_convoy": 80,
        "quests/side_quest/sq027_02_raffen_shiv_attack": 100
      },
      "active": [
        "quests/main_quest/act_01/q104",
        "quests/side_quest/sq004",
        "quests/side_quest/sq027",
        "quests/main_quest/act_01/q114"
      ]
    },
    "kerry-eurodyne": {
      "quests": {
        "quests/side_quest/sq011_kerry": 80,
        "quests/side_quest/sq011_concert": 60,
        "quests/side_quest/sq017_kerry": 60,
        "quests/side_quest/sq017_01_riot_club": 50,
        "quests/side_quest/sq017_02_lounge": 50,
        "quests/side_quest/sq028_kerry_romance": 50
      },
      "active": [
        "quests/side_quest/sq011",
        "quests/side_quest/sq017",
        "quests/side_quest/sq028"
      ]
    },
    "river-ward": {
      "quests": {
        "quests/side_quest/sq021_sick_dreams": 150,
        "quests/minor_quest/mq057_motorbreath": 50,
        "quests/side_quest/sq029_sobchak_romance": 150
      },
      "active": [
        "quests/side_quest/sq021",
        "quests/side_quest/sq029",
        "quests/minor_quest/mq057"
      ]
    },
    "rogue-amendiares": {
      "quests": {
        "quests/main_quest/act_01/q103_warhead": 60,
        "quests/side_quest/sq031_rogue": 70,
        "quests/side_quest/sq031_smack_my_bitch_up": 60,
        "quests/side_quest/sq031_cinema": 70,
        "quests/main_quest/act_01/q115_afterlife": 40,
        "quests/main_quest/act_01/q115_rogues_last_flight": 50
      },
      "active": [
        "quests/main_quest/act_01/q103",
        "quests/side_quest/sq031",
        "quests/main_quest/act_01/q115"
      ]
    },
    "johnny-silverhand": {
      "quests": {
        "quests/main_quest/act_01/q101_01_firestorm": 60,
        "quests/main_quest/act_01/q108_johnny": 120,
        "quests/side_quest/sq011_concert": 80,
        "quests/side_quest/sq031_rogue": 90
      },
      "active": [
        "quests/main_quest/act_01/q108",
        "quests/side_quest/sq011",
        "quests/side_quest/sq031"
      ]
    },
    "takemura": {
      "quests": {
        "quests/main_quest/act_01/q112_01_old_friend": 60,
        "quests/main_quest/act_01/q112_02_industrial_park": 70,
        "quests/main_quest/act_01/q112_03_dashi_parade": 80,
        "quests/main_quest/act_01/q112_04_hideout": 60,
        "quests/main_quest/act_01/q113_rescuing_hanako": 80
      },
      "active": [
        "quests/main_quest/act_01/q112",
        "quests/main_quest/act_01/q113"
      ]
    },
    "jackie-welles": {
      "quests": {
        "quests/main_quest/prologue/q001_01_victor": 80,
        "quests/main_quest/prologue/q001_02_dex": 80,
        "quests/main_quest/prologue/q005_heist": 190
      },
      "active": [
        "quests/main_quest/prologue/q00",
        "quests/side_quest/sq018"
      ]
    },
    "misty-olszewski": {
      "quests": {
        "quests/minor_quest/mq033_tarot": 200,
        "ep1/quests/minor_quest/mq033_ep1": 150
      },
      "active": [
        "quests/minor_quest/mq033",
        "ep1/quests/minor_quest/mq033"
      ]
    },
    "viktor-vektor": {
      "quests": {
        "quests/main_quest/prologue/q001_01_victor": 100,
        "quests/minor_quest/mq045_victor_debt": 150,
        "quests/minor_quest/mq033_tarot": 100
      },
      "active": [
        "quests/minor_quest/mq045"
      ]
    },
    "claire-russell": {
      "quests": {
        "quests/side_quest/sq024_badlands_race": 70,
        "quests/side_quest/sq024_city_race": 70,
        "quests/side_quest/sq024_santo_domingo_race": 70,
        "quests/side_quest/sq024_the_big_race": 140
      },
      "active": [
        "quests/side_quest/sq024"
      ]
    },
    "alt-cunningham": {
      "quests": {
        "quests/main_quest/act_01/q110_01_voodooboys": 80,
        "quests/main_quest/act_01/q110_voodoo": 70,
        "quests/main_quest/act_01/q110_03_cyberspace": 200
      },
      "active": [
        "quests/main_quest/act_01/q110"
      ]
    }
  },
  "endgame": [
    "quests/main_quest/act_01/q113_corpo",
    "quests/main_quest/act_01/q114",
    "quests/main_quest/act_01/q115",
    "quests/main_quest/act_01/q116",
    "ep1/quests/main_quest/q306",
    "ep1/quests/main_quest/q307"
  ]
};
