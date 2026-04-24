/**
 * Human-readable names for OSRS sequence ids — seed data for the
 * "any animation" picker's display labels.
 *
 * The cache doesn't store these; the client hard-codes animation ids in its
 * game scripts. This table is extracted by hand from community notes and
 * RuneLite's `AnimationID` constants (MIT-licensed). The coverage is
 * deliberately modest for now — every entry here shows a friendly label in
 * the search; unknown ids show `#<id>` and still work. Extending it is
 * safe: add new rows, reload, done.
 *
 * Indexed-lookup form (not a TS enum) because the table will get large and
 * we want a straight `Map` lookup on the client.
 */

type NamedAnimation = { id: number; name: string };

const ENTRIES: NamedAnimation[] = [
  // Emotes — standard player/NPC social animations. IDs from the Emotes
  // tab in the client; stable across OSRS builds.
  { id: 855, name: "Emote: Yes" },
  { id: 856, name: "Emote: No" },
  { id: 857, name: "Emote: Bow" },
  { id: 858, name: "Emote: Angry" },
  { id: 859, name: "Emote: Think" },
  { id: 860, name: "Emote: Wave" },
  { id: 861, name: "Emote: Shrug" },
  { id: 862, name: "Emote: Cheer" },
  { id: 863, name: "Emote: Beckon" },
  { id: 864, name: "Emote: Laugh" },
  { id: 866, name: "Emote: Jump for joy" },
  { id: 867, name: "Emote: Yawn" },
  { id: 868, name: "Emote: Dance" },
  { id: 869, name: "Emote: Jig" },
  { id: 870, name: "Emote: Spin" },
  { id: 871, name: "Emote: Headbang" },
  { id: 872, name: "Emote: Cry" },
  { id: 873, name: "Emote: Blow kiss" },
  { id: 874, name: "Emote: Panic" },
  { id: 1368, name: "Emote: Flap" },
  { id: 1370, name: "Emote: Idea" },
  { id: 1371, name: "Emote: Stamp" },
  { id: 1372, name: "Emote: Clap" },
  { id: 1131, name: "Emote: Raspberry" },
  { id: 2113, name: "Emote: Salute" },
  { id: 2837, name: "Emote: Goblin bow" },
  { id: 2836, name: "Emote: Goblin salute" },
  { id: 3544, name: "Emote: Give thanks" },
  { id: 3866, name: "Emote: Air guitar" },
  { id: 7531, name: "Emote: Trick" },

  // Movement / idle basics that show up on many humanoid NPCs.
  { id: 808, name: "Idle (humanoid)" },
  { id: 819, name: "Walk (humanoid)" },
  { id: 820, name: "Walk forward" },
  { id: 821, name: "Walk backward" },
  { id: 822, name: "Walk strafe left" },
  { id: 823, name: "Walk strafe right" },
  { id: 824, name: "Turn 180" },
  { id: 825, name: "Run" },

  // Combat — generic player weapon-type attack animations. IDs from
  // RuneLite's WeaponType enum.
  { id: 386, name: "Attack: Stab" },
  { id: 390, name: "Attack: Slash" },
  { id: 393, name: "Attack: Block" },
  { id: 400, name: "Attack: Crush" },
  { id: 406, name: "Attack: Unarmed punch" },
  { id: 412, name: "Attack: Unarmed kick" },
  { id: 422, name: "Attack: Generic" },
  { id: 424, name: "Attack: Sword slash" },
  { id: 426, name: "Attack: Halberd" },
  { id: 428, name: "Attack: Staff crush" },
  { id: 440, name: "Attack: Axe chop" },
  { id: 451, name: "Attack: Mace" },
  { id: 1378, name: "Attack: 2h slash" },
  { id: 1379, name: "Attack: 2h stab" },
  { id: 2067, name: "Attack: Dagger" },
  { id: 2075, name: "Attack: Claws" },
  { id: 2080, name: "Attack: Whip" },
  { id: 7041, name: "Attack: Scythe of Vitur" },

  // Magic — common spell cast animations.
  { id: 711, name: "Cast: Wind strike" },
  { id: 727, name: "Cast: Water strike" },
  { id: 728, name: "Cast: Earth strike" },
  { id: 729, name: "Cast: Fire strike" },
  { id: 711, name: "Cast: Air wave" },
  { id: 1162, name: "Cast: High alchemy" },
  { id: 811, name: "Cast: Teleport" },
  { id: 8939, name: "Cast: Tele-group" },

  // Skilling — these surface on gatherable locs too but work as NPC
  // actions when you want a woodcutter/miner idle pose.
  { id: 622, name: "Skill: Woodcutting" },
  { id: 625, name: "Skill: Mining" },
  { id: 623, name: "Skill: Fishing (rod)" },
  { id: 618, name: "Skill: Fishing (net)" },
  { id: 896, name: "Skill: Cooking" },
  { id: 883, name: "Skill: Smithing" },
  { id: 733, name: "Skill: Prayer" },

  // Death poses — often used for lore-posed NPCs.
  { id: 836, name: "Death (humanoid)" },
  { id: 2304, name: "Death (zombie)" },

  // Dragon / boss-ish behaviours common enough to name.
  { id: 81, name: "Dragon: Fire breath" },
  { id: 91, name: "Dragon: Attack" },
  { id: 90, name: "Dragon: Idle" },
  { id: 92, name: "Dragon: Walk" },
];

const BY_ID = new Map<number, string>(ENTRIES.map((e) => [e.id, e.name]));

/** Returns the human-friendly label for a sequence id, or `null` if we
 *  don't have one (caller renders `#<id>` as a fallback). */
export function animationName(id: number): string | null {
  return BY_ID.get(id) ?? null;
}

/** Returns every named animation as `{id, name}` rows — useful when the
 *  user hasn't loaded the full server-side catalog yet. */
export function knownNamedAnimations(): NamedAnimation[] {
  return ENTRIES.slice();
}
