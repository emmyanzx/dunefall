export type SpeakerId = "overwatch" | "chassis" | "vex";

export type RadioMessage = {
  id: string;
  speaker: SpeakerId;
  callsign: string;
  role: string;
  text: string;
  duration?: number;
};

export type TacticalChoiceId =
  | "overclock_rail"
  | "reinforce_plate"
  | "drone_uplink"
  | "drive_servos"
  | "salvage_cells"
  | "pierce_rounds";

export type TacticalChoice = {
  id: TacticalChoiceId;
  title: string;
  tag: string;
  effectText: string;
  response: RadioMessage;
};

export type ChapterAtmosphere = {
  fogColor: number;
  fogDensity: number;
  sunColor: number;
  sunIntensity: number;
  hemiSky: number;
  hemiGround: number;
  skyTint: number;
};

export type ChapterObjectiveType =
  | "recon_and_cores"
  | "capture_relays"
  | "escort_convoy"
  | "destroy_pylons"
  | "boss_solaris";

export type ChapterDef = {
  index: number; // 0..4
  number: number; // 1..5
  code: string;
  title: string;
  sector: string;
  summary: string;
  objectiveType: ChapterObjectiveType;
  briefing: string;
  hint: string;
  atmosphere: ChapterAtmosphere;
  introComms: RadioMessage[];
  twistComms: RadioMessage[];
  clearComms: RadioMessage[];
  debriefChoices?: [TacticalChoice, TacticalChoice];
};

export const SPEAKER_META: Record<SpeakerId, { callsign: string; role: string; accent: string }> = {
  overwatch: { callsign: "CMDR. KORA", role: "OVERWATCH-01", accent: "#e6a84c" },
  chassis: { callsign: "VANGUARD-OS", role: "CHASSIS AI", accent: "#4ade80" },
  vex: { callsign: "WARDEN VEX", role: "CRIMSON ACE", accent: "#ef4444" },
};

function line(id: string, speaker: SpeakerId, text: string, duration = 4.6): RadioMessage {
  const m = SPEAKER_META[speaker];
  return { id, speaker, callsign: m.callsign, role: m.role, text, duration };
}

export const CHAPTERS: ChapterDef[] = [
  {
    index: 0,
    number: 1,
    code: "OP-01",
    title: "FIRST CONTACT",
    sector: "Outpost Ridge",
    summary: "Eliminate the Crimson vanguard and salvage 3 dropped Helios Relay Cores.",
    objectiveType: "recon_and_cores",
    briefing:
      "Crimson Directorate recon mechs have breached Outpost Ridge to strip the basin's Helios fusion grid. Break their point squad, then recover 3 emerald Relay Cores before their orbital jammer locks down.",
    hint: "Press T to morph into your 6-wheel Combat Car for rapid core runs across the dunes.",
    atmosphere: {
      fogColor: 0x7c6866,
      fogDensity: 0.009,
      sunColor: 0xffcb94,
      sunIntensity: 3.1,
      hemiSky: 0xa99ba6,
      hemiGround: 0x6e4a30,
      skyTint: 0xffffff,
    },
    introComms: [
      line(
        "c1_i1",
        "overwatch",
        "Vanguard, welcome to Sector 09. Crimson scouts are crossing Outpost Ridge—clear them off the grid.",
        4.8
      ),
      line(
        "c1_i2",
        "chassis",
        "Combat chassis online. Twin rotary cannons green. Recommend target lock [Q] and car morph [T] across open sand.",
        4.6
      ),
    ],
    twistComms: [
      line(
        "c1_t1",
        "overwatch",
        "Good shooting—their point squad dropped 3 encrypted Relay Cores! Morph to Car [T] and grab them before reinforcements close in.",
        5.2
      ),
      line(
        "c1_t2",
        "vex",
        "Static on an open band... A lone bronze antique defending the Glass Reach? Enjoy the warm-up, freelancer.",
        5.0
      ),
    ],
    clearComms: [
      line(
        "c1_c1",
        "chassis",
        "All three Helios cores secured. Decrypting Warden Vex's carrier telemetry now.",
        4.2
      ),
      line(
        "c1_c2",
        "overwatch",
        "That voice was Warden Vex—the Directorate's butcher. Regroup and pick your field refit before Red Canyon.",
        4.8
      ),
    ],
    debriefChoices: [
      {
        id: "overclock_rail",
        title: "OVERCLOCK WEAPON RAILS",
        tag: "OFFENSE",
        effectText: "+25% weapon damage across the rest of the campaign.",
        response: line("ch_or", "chassis", "Thermal limiters adjusted. Ballistic and rail output increased by 25 percent."),
      },
      {
        id: "reinforce_plate",
        title: "REINFORCE COMPOSITE PLATE",
        tag: "DEFENSE",
        effectText: "+45 Max Hull and +35 Max Armor Plate permanently.",
        response: line("ch_rp", "overwatch", "Smart call—Crimson heavy breachers hit hard in Red Canyon."),
      },
    ],
  },
  {
    index: 1,
    number: 2,
    code: "OP-02",
    title: "SIGNAL FIRE",
    sector: "Red Canyon",
    summary: "Capture and hold 2 Helios Relay Towers inside the canyon killzone.",
    objectiveType: "capture_relays",
    briefing:
      "Warden Vex's jammers have blinded our orbital net. Fight onto the twin canyon ridges and hold inside each Helios Relay ring until its emerald uplink locks at 100%.",
    hint: "Stay inside the glowing emerald ring to charge each tower. Capturing a relay restores +35 Hull.",
    atmosphere: {
      fogColor: 0x8f6b56,
      fogDensity: 0.0096,
      sunColor: 0xffb974,
      sunIntensity: 3.3,
      hemiSky: 0xb89682,
      hemiGround: 0x7a4826,
      skyTint: 0xffead6,
    },
    introComms: [
      line(
        "c2_i1",
        "overwatch",
        "Two Helios Relay Towers are dark on your radar. Hold inside their perimeter rings to force a manual uplink.",
        5.0
      ),
      line(
        "c2_i2",
        "chassis",
        "Relay beacons marked on HUD. Warning: standing still draws heavy fire—use Brace Shield [RMB] when holding the ring.",
        4.8
      ),
    ],
    twistComms: [
      line(
        "c2_t1",
        "vex",
        "Rebuilding their signal net? Cute. Heavy Breachers, crush the second spire—leave nothing but slag.",
        4.8
      ),
      line(
        "c2_t2",
        "overwatch",
        "First relay online! Heavy Crimson armor dropping on Relay B—deploy your Support Squad [4] and Missile Pod [5]!",
        5.0
      ),
    ],
    clearComms: [
      line(
        "c2_c1",
        "overwatch",
        "Both Helios spires are singing! Orbital sat-link restored—wait, I'm picking up a friendly distress beacon!",
        4.8
      ),
      line(
        "c2_c2",
        "chassis",
        "Tracking armored supply rig ATLAS-6 in the Shattered Basin. Crimson interceptors converging.",
        4.4
      ),
    ],
    debriefChoices: [
      {
        id: "drone_uplink",
        title: "FORWARD DRONE UPLINK",
        tag: "SUPPORT",
        effectText: "Support Squad [4] and Missile Pod [5] recharge 35% faster.",
        response: line("ch_du", "overwatch", "Orbital drop relays synced. Call in your drone wing early and often."),
      },
      {
        id: "drive_servos",
        title: "HIGH-TORQUE DRIVE SERVOS",
        tag: "MOBILITY",
        effectText: "+22% Mech & Car movement speed and faster side-roll recovery.",
        response: line("ch_ds", "chassis", "Actuator torque boosted. We can outflank every raider in the basin."),
      },
    ],
  },
  {
    index: 2,
    number: 3,
    code: "OP-03",
    title: "IRON CONVOY",
    sector: "Shattered Basin",
    summary: "Escort armored core hauler ATLAS-6 through Crimson ambush canyons to extraction.",
    objectiveType: "escort_convoy",
    briefing:
      "Armored transport ATLAS-6 is carrying the basin's last stabilized fusion core through a rising sandstorm. Stay close to boost its convoy drive and intercept Crimson raiders before they breach its hull.",
    hint: "Stay within 24m of ATLAS-6 to activate ESCORT BOOST. Use [4] Support Squad to screen ambushers.",
    atmosphere: {
      fogColor: 0x996548,
      fogDensity: 0.0112,
      sunColor: 0xffa05a,
      sunIntensity: 2.9,
      hemiSky: 0xc48b6c,
      hemiGround: 0x6b3a1e,
      skyTint: 0xffd2b3,
    },
    introComms: [
      line(
        "c3_i1",
        "overwatch",
        "ATLAS-6 is rolling north through the storm. Keep close to its flank—if that core blows, the basin goes dark.",
        5.0
      ),
      line(
        "c3_i2",
        "chassis",
        "Escort proximity link active. Staying within 24 meters boosts ATLAS-6 cruising speed.",
        4.6
      ),
    ],
    twistComms: [
      line(
        "c3_t1",
        "vex",
        "You're dragging that scrap-hauler straight into my killbox. Raiders, lock onto the transport!",
        4.8
      ),
      line(
        "c3_t2",
        "overwatch",
        "Crimson ambush ahead of the convoy! Intercept them before they get clean rail shots on ATLAS-6!",
        4.8
      ),
    ],
    clearComms: [
      line(
        "c3_c1",
        "overwatch",
        "ATLAS-6 cleared the northern gate! The city shield generators are holding because of you.",
        4.8
      ),
      line(
        "c3_c2",
        "chassis",
        "Alert: massive seismic spikes ahead. Three Crimson Artillery Pylons are priming to level the ridge.",
        4.8
      ),
    ],
    debriefChoices: [
      {
        id: "salvage_cells",
        title: "SALVAGE MISSILE CAPACITORS",
        tag: "ORDNANCE",
        effectText: "+4 Max Missile Cells (10 total) and full Hull/Plate restore.",
        response: line("ch_sc", "chassis", "Ten-cell salvo rack online. Press [F] to rain fire on hardened targets."),
      },
      {
        id: "pierce_rounds",
        title: "TUNGSTEN PIERCE CORES",
        tag: "ANTI-ARMOR",
        effectText: "+35% bonus damage against Pylons, Heavy Mechs, and Boss armor.",
        response: line("ch_pr", "overwatch", "Tungsten penetrators loaded. Crack those siege pylons wide open."),
      },
    ],
  },
  {
    index: 3,
    number: 4,
    code: "OP-04",
    title: "SCORCHED EARTH",
    sector: "Ash Caldera",
    summary: "Destroy 3 Crimson Artillery Pylons while dodging orbital mortar strikes.",
    objectiveType: "destroy_pylons",
    briefing:
      "Three armored Crimson Artillery Pylons are shelling the Glass Reach. Weave between their glowing red impact zones—use Car morph [T] or Side-Roll [Shift+A/D]—and shatter all three towers.",
    hint: "RAILBREAKER [K] and CRATERFALL [L] shred Artillery Pylons fast. Watch for red ground target rings!",
    atmosphere: {
      fogColor: 0x6a4954,
      fogDensity: 0.0108,
      sunColor: 0xff8b62,
      sunIntensity: 2.8,
      hemiSky: 0x996e7d,
      hemiGround: 0x4f2b22,
      skyTint: 0xecc4d0,
    },
    introComms: [
      line(
        "c4_i1",
        "overwatch",
        "Three siege pylons are zeroing in on our bunker! Smash every pylon—and stay out of those crimson impact rings!",
        5.0
      ),
      line(
        "c4_i2",
        "chassis",
        "Incoming shell trajectories mapped onto the sand. Switching to RAILBREAKER [K] or CRATERFALL [L] recommended.",
        4.8
      ),
    ],
    twistComms: [
      line(
        "c4_t1",
        "vex",
        "Enough. You've bled my vanguard, saved their hauler, and cracked my guns. One pylon left—I'm coming down myself.",
        5.2
      ),
      line(
        "c4_t2",
        "overwatch",
        "Orbital drop signature inbound—massive tonnage! Finish that final pylon and brace for Warden Vex!",
        4.8
      ),
    ],
    clearComms: [
      line(
        "c4_c1",
        "chassis",
        "All Crimson Artillery Pylons neutralized. Warning: eclipse thermal spike directly north.",
        4.6
      ),
      line(
        "c4_c2",
        "overwatch",
        "Vex is dropping in SOLARIS-0. Take a breath, Pilot—everything in Sector 09 comes down to this duel.",
        5.0
      ),
    ],
  },
  {
    index: 4,
    number: 5,
    code: "OP-05",
    title: "SUNBREAKER",
    sector: "The Glass Reach",
    summary: "Defeat Warden Vex and his dreadnought SOLARIS-0 in a two-phase showdown.",
    objectiveType: "boss_solaris",
    briefing:
      "Warden Vex has descended in SOLARIS-0, a double-scale Crimson siege dreadnought armed with twin plasma railguns and solar mortar barrages. Break its shields, survive Solar Overdrive at 50% HP, and end the siege.",
    hint: "Use mesas for cover during Solar Barrages, Brace [RMB] heavy bursts, and unleash [4], [5], and [F]!",
    atmosphere: {
      fogColor: 0x52343c,
      fogDensity: 0.011,
      sunColor: 0xff7043,
      sunIntensity: 3.0,
      hemiSky: 0x85535f,
      hemiGround: 0x422019,
      skyTint: 0xd9a8b0,
    },
    introComms: [
      line(
        "c5_i1",
        "vex",
        "SOLARIS-0 touchdown confirmed. No squads to hide behind, little strider—show me if that bronze frame can burn!",
        5.2
      ),
      line(
        "c5_i2",
        "chassis",
        "Dreadnought class target locked. Multiple thermal emitters detected. Recommend sustained fire and mesa cover.",
        4.8
      ),
    ],
    twistComms: [
      line(
        "c5_t1",
        "vex",
        "ARGH—hull breach?! Reactor seals OFF! SOLAR OVERDRIVE—I'll glass this entire basin with you in it!",
        5.4
      ),
      line(
        "c5_t2",
        "chassis",
        "Overriding our own thermal safeties, Pilot! Missile rack maxed and cooldowns boosted—FINISH SOLARIS-0!",
        5.2
      ),
    ],
    clearComms: [
      line(
        "c5_c1",
        "vex",
        "Reactor... critical... impossible... a desert relic broke... SOLARIS... [SIGNAL LOST]",
        5.0
      ),
      line(
        "c5_c2",
        "overwatch",
        "SOLARIS-0 is down!! The Crimson fleet is pulling out of orbit—Sector 09 is ours! Hell of a fight, Pilot!",
        5.4
      ),
    ],
  },
];

export type CampaignSave = {
  unlockedChapter: number; // 0..4
  completed: boolean;
  bestScore: number;
  bestRank: "S" | "A" | "B" | "C" | "";
};

const SAVE_KEY = "dunefall_story_save_v1";

export function loadCampaignSave(): CampaignSave {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<CampaignSave>;
      return {
        unlockedChapter: Math.max(0, Math.min(CHAPTERS.length - 1, Number(parsed.unlockedChapter ?? 0))),
        completed: Boolean(parsed.completed),
        bestScore: Math.max(0, Number(parsed.bestScore ?? 0)),
        bestRank:
          parsed.bestRank === "S" || parsed.bestRank === "A" || parsed.bestRank === "B" || parsed.bestRank === "C"
            ? parsed.bestRank
            : "",
      };
    }
  } catch {
    // ignore storage failures in private iframes
  }
  return { unlockedChapter: 0, completed: false, bestScore: 0, bestRank: "" };
}

export function persistCampaignSave(save: CampaignSave) {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify(save));
  } catch {
    // ignore storage failures
  }
}

export type CampaignRuntimeState = {
  chapterIdx: number;
  choices: Set<TacticalChoiceId>;
  totalTime: number;
  chapterTime: number;
  deaths: number;
  damageMult: number;
  armorPierceMult: number;
  speedMult: number;
  cooldownMult: number;
  bonusHull: number;
  bonusPlate: number;
  bonusCells: number;
};

export function createFreshCampaignState(startChapter = 0): CampaignRuntimeState {
  return {
    chapterIdx: Math.max(0, Math.min(CHAPTERS.length - 1, startChapter)),
    choices: new Set<TacticalChoiceId>(),
    totalTime: 0,
    chapterTime: 0,
    deaths: 0,
    damageMult: 1,
    armorPierceMult: 1,
    speedMult: 1,
    cooldownMult: 1,
    bonusHull: 0,
    bonusPlate: 0,
    bonusCells: 0,
  };
}

export function applyTacticalChoice(state: CampaignRuntimeState, choiceId: TacticalChoiceId) {
  if (state.choices.has(choiceId)) return;
  state.choices.add(choiceId);
  switch (choiceId) {
    case "overclock_rail":
      state.damageMult *= 1.25;
      break;
    case "reinforce_plate":
      state.bonusHull += 45;
      state.bonusPlate += 35;
      break;
    case "drone_uplink":
      state.cooldownMult *= 0.65;
      break;
    case "drive_servos":
      state.speedMult *= 1.22;
      break;
    case "salvage_cells":
      state.bonusCells += 4;
      break;
    case "pierce_rounds":
      state.armorPierceMult *= 1.35;
      break;
  }
}

export function computeCampaignRank(score: number, deaths: number, totalSeconds: number): "S" | "A" | "B" | "C" {
  if (deaths === 0 && score >= 9000 && totalSeconds <= 660) return "S";
  if (deaths <= 1 && score >= 6000) return "A";
  if (score >= 3500) return "B";
  return "C";
}

/** Validate campaign graph at startup (zero broken choice IDs or missing chapters) */
export function validateCampaignData(): string[] {
  const errs: string[] = [];
  if (CHAPTERS.length !== 5) errs.push(`Expected 5 chapters, got ${CHAPTERS.length}`);
  const seenIds = new Set<string>();
  for (let i = 0; i < CHAPTERS.length; i++) {
    const ch = CHAPTERS[i];
    if (ch.index !== i) errs.push(`Chapter ${ch.code} index mismatch`);
    for (const msg of [...ch.introComms, ...ch.twistComms, ...ch.clearComms]) {
      if (seenIds.has(msg.id)) errs.push(`Duplicate radio message ID: ${msg.id}`);
      seenIds.add(msg.id);
    }
    if (ch.debriefChoices) {
      for (const c of ch.debriefChoices) {
        if (seenIds.has(c.response.id)) errs.push(`Duplicate choice response ID: ${c.response.id}`);
        seenIds.add(c.response.id);
      }
    }
  }
  return errs;
}

/** Crisp SVG portrait avatars for the non-blocking tactical radio comms card */
export function getSpeakerPortraitSvg(speaker: SpeakerId): string {
  if (speaker === "overwatch") {
    return `<svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect width="48" height="48" rx="4" fill="#1e1916"/>
      <path d="M12 39c2-7 7-10 12-10s10 3 12 10" stroke="#e6a84c" stroke-width="2.2" fill="#2c2219"/>
      <circle cx="24" cy="19" r="7.5" fill="#3a2d21" stroke="#e6a84c" stroke-width="2"/>
      <path d="M15 19c0-5.5 4-10 9-10s9 4.5 9 10" stroke="#f5c77a" stroke-width="2.2"/>
      <rect x="13" y="17" width="3.5" height="6" rx="1.5" fill="#e6a84c"/>
      <path d="M15 23l5 2.5" stroke="#e6a84c" stroke-width="1.8" stroke-linecap="round"/>
      <circle cx="20.5" cy="25.8" r="1.4" fill="#fde68a"/>
      <rect x="20" y="17.5" width="8" height="2.4" rx="1" fill="#f5b942" opacity="0.85"/>
    </svg>`;
  }
  if (speaker === "chassis") {
    return `<svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect width="48" height="48" rx="4" fill="#121b17"/>
      <polygon points="24,8 38,16 38,32 24,40 10,32 10,16" fill="#1a2c24" stroke="#4ade80" stroke-width="2"/>
      <rect x="15" y="21" width="18" height="5" rx="2" fill="#4ade80"/>
      <circle cx="24" cy="23.5" r="1.6" fill="#ecfdf5"/>
      <path d="M17 31h14M20 14h8" stroke="#86efac" stroke-width="1.8" stroke-linecap="round"/>
    </svg>`;
  }
  return `<svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
    <rect width="48" height="48" rx="4" fill="#201215"/>
    <path d="M11 39l4-10h18l4 10" fill="#35161b" stroke="#ef4444" stroke-width="2"/>
    <polygon points="24,7 35,14 33,28 24,33 15,28 13,14" fill="#2b1216" stroke="#ef4444" stroke-width="2"/>
    <path d="M16 19l8 3 8-3-3 5-5 1.5-5-1.5-3-5z" fill="#ff3b3b"/>
    <path d="M19 11l5 4 5-4" stroke="#fca5a5" stroke-width="1.8"/>
  </svg>`;
}
