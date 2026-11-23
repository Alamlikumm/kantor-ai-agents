import * as THREE from 'three';
import { SKIN } from '../shared/roster.js';

const matCache = new Map();
export function mat(color, opts = {}) {
  const key = color + JSON.stringify(opts);
  if (!matCache.has(key)) matCache.set(key, new THREE.MeshLambertMaterial({ color, ...opts }));
  return matCache.get(key);
}

const geoCache = new Map();
function geo(w, h, d) {
  const key = `${w}|${h}|${d}`;
  if (!geoCache.has(key)) geoCache.set(key, new THREE.BoxGeometry(w, h, d));
  return geoCache.get(key);
}

export function box(w, h, d, color, x = 0, y = 0, z = 0, opts = {}) {
  const m = new THREE.Mesh(geo(w, h, d), typeof color === 'string' ? mat(color, opts) : color);
  m.position.set(x, y, z);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const damp = (cur, target, rate, dt) => cur + (target - cur) * (1 - Math.exp(-rate * dt));
const lerp = (a, b, t) => a + (b - a) * t;

function shade(hex, amount) {
  const c = new THREE.Color(hex);
  c.offsetHSL(0, 0, amount);
  return `#${c.getHexString()}`;
}

const PANTS = ['#2f3a4a', '#3b3b4f', '#4a3f35', '#2a2f3a', '#454a57'];

// Warna pakaian perempuan — lebih variatif dan pastel
const FEMALE_SHIRTS = ['#c9748a', '#8b6fae', '#5a9ec9', '#7ab87a', '#d4875e'];
const FEMALE_SKIRTS = ['#e8c5d0', '#d1c5e8', '#c5dde8', '#c5e8c5', '#ede0c5'];

function buildHair(head, look, hairColor) {
  const hair = new THREE.Group();
  hair.add(box(0.5, 0.14, 0.5, hairColor, 0, 0.47, 0));
  hair.add(box(0.5, 0.07, 0.07, hairColor, 0, 0.42, 0.235));
  hair.add(box(0.5, 0.3, 0.1, hairColor, 0, 0.32, -0.22));
  if (look.style === 'long') {
    hair.add(box(0.5, 0.6, 0.12, hairColor, 0, 0.14, -0.22));
    hair.add(box(0.07, 0.3, 0.3, hairColor, 0.245, 0.3, -0.05));
    hair.add(box(0.07, 0.3, 0.3, hairColor, -0.245, 0.3, -0.05));
  } else if (look.style === 'bun') {
    hair.add(box(0.2, 0.2, 0.2, hairColor, 0, 0.64, -0.12));
  } else {
    hair.add(box(0.07, 0.2, 0.3, hairColor, 0.245, 0.34, -0.05));
    hair.add(box(0.07, 0.2, 0.3, hairColor, -0.245, 0.34, -0.05));
  }
  head.add(hair);
}

function buildHijab(head, color) {
  const g = new THREE.Group();
  const dark = shade(color, -0.08);
  g.add(box(0.56, 0.16, 0.56, color, 0, 0.47, -0.01));
  g.add(box(0.56, 0.52, 0.16, color, 0, 0.2, -0.22));
  g.add(box(0.08, 0.46, 0.4, color, 0.255, 0.26, -0.02));
  g.add(box(0.08, 0.46, 0.4, color, -0.255, 0.26, -0.02));
  g.add(box(0.2, 0.06, 0.06, dark, 0, 0.44, 0.255));
  g.add(box(0.58, 0.2, 0.5, dark, 0, -0.04, -0.02));
  head.add(g);
}

export function createCharacter(agent, divisionColor, index = 0) {
  const look = agent.look;
  const skin = SKIN[look.skin ?? 1];
  const hairColor = look.hair || '#1c1c1c';
  const leader = agent.leader;
  const isFemale = agent.gender === 'F';

  // ---- Proporsi berdasarkan gender ----
  // Perempuan: bahu lebih sempit, pinggang lebih kecil, sedikit lebih pendek
  // Laki-laki: bahu lebih lebar, postur lebih tegap
  const shoulderW   = isFemale ? 0.44 : 0.52;
  const torsoH      = isFemale ? 0.56 : 0.60;
  const torsoD      = isFemale ? 0.26 : 0.30;
  const waistOffset = isFemale ? 0.28 : 0.30;  // posisi y torso
  const armOffset   = isFemale ? 0.31 : 0.35;  // jarak lengan dari center
  const legW        = isFemale ? 0.17 : 0.20;
  const shoeH       = isFemale ? 0.06 : 0.08;  // perempuan sepatu lebih tipis
  const shoeW       = isFemale ? 0.19 : 0.22;

  // ---- Warna pakaian ----
  const shirt = leader
    ? (isFemale ? FEMALE_SHIRTS[index % FEMALE_SHIRTS.length] : '#2d3748')
    : (isFemale
        ? FEMALE_SHIRTS[(agent.name.length + index + 2) % FEMALE_SHIRTS.length]
        : shade(divisionColor, [-0.06, 0.0, 0.08, -0.12][index % 4]));
  const pants = isFemale
    ? FEMALE_SKIRTS[(agent.name.length + index) % FEMALE_SKIRTS.length]
    : PANTS[(agent.name.length + index) % PANTS.length];
  const shoeColor = isFemale ? '#5a3a4a' : '#1f1f24';

  const root = new THREE.Group();
  root.name = agent.id;
  const hips = new THREE.Group();
  root.add(hips);

  // torso — proporsi berbeda pria vs wanita
  hips.add(box(shoulderW, torsoH, torsoD, shirt, 0, waistOffset, 0));
  if (leader) {
    // Leader: badge / kerah formal
    hips.add(box(0.14, 0.34, 0.02, '#f5f5f5', 0, 0.38, 0.16));
    hips.add(box(0.07, 0.3, 0.02, divisionColor, 0, 0.36, 0.17));
  } else if (isFemale) {
    // Wanita non-leader: aksesori blus (kancing kecil)
    hips.add(box(0.04, 0.22, 0.02, '#ffffff', 0, 0.38, 0.14));
    hips.add(box(0.08, 0.08, 0.02, shade(shirt, 0.1), 0, 0.52, 0.14));
  } else {
    // Pria non-leader: saku kecil
    hips.add(box(0.05, 0.3, 0.02, '#f4f4f4', 0.1, 0.36, 0.16));
    hips.add(box(0.12, 0.14, 0.02, '#ffffff', 0.1, 0.2, 0.16));
  }

  // Rok / bawahan perempuan (overlay di atas kaki)
  if (isFemale) {
    hips.add(box(shoulderW + 0.04, 0.18, torsoD + 0.04, pants, 0, -0.02, 0));
  }

  // head
  const head = new THREE.Group();
  head.position.set(0, 0.6, 0);
  hips.add(head);
  // Wajah perempuan sedikit lebih kecil/oval
  const faceW = isFemale ? 0.42 : 0.46;
  const faceH = isFemale ? 0.44 : 0.46;
  head.add(box(faceW, faceH, 0.46, skin, 0, 0.25, 0));
  head.add(box(isFemale ? 0.08 : 0.1, 0.1, 0.1, skin, 0, 0.02, 0));
  // Alis — perempuan lebih halus (lebih tipis)
  head.add(box(isFemale ? 0.06 : 0.07, isFemale ? 0.055 : 0.08, 0.02, '#1b1b1b', 0.11, 0.28, 0.235));
  head.add(box(isFemale ? 0.06 : 0.07, isFemale ? 0.055 : 0.08, 0.02, '#1b1b1b', -0.11, 0.28, 0.235));
  // Bibir — perempuan lebih merah
  head.add(box(0.1, 0.03, 0.02, isFemale ? '#c0404a' : '#8a4545', 0, 0.12, 0.235));
  if (look.glasses) {
    const lens = mat('#9ec5ff', { transparent: true, opacity: 0.35 });
    head.add(box(0.16, 0.13, 0.02, lens, 0.11, 0.28, 0.245));
    head.add(box(0.16, 0.13, 0.02, lens, -0.11, 0.28, 0.245));
    head.add(box(0.4, 0.02, 0.02, '#202020', 0, 0.3, 0.255));
  }
  if (look.hijab) buildHijab(head, look.hijab);
  else buildHair(head, look, hairColor);

  // legs — proporsi berbeda pria vs wanita
  const legs = [];
  for (const side of [1, -1]) {
    const thigh = new THREE.Group();
    thigh.position.set(side * 0.11, 0, 0);
    // Wanita: pakai warna rok di paha atas, celana di bawah
    const thighColor = isFemale ? pants : PANTS[(agent.name.length + index) % PANTS.length];
    const lowerColor = isFemale ? shade(skin, -0.05) : PANTS[(agent.name.length + index) % PANTS.length];
    thigh.add(box(legW, 0.4, isFemale ? 0.18 : 0.2, thighColor, 0, -0.2, 0));
    const knee = new THREE.Group();
    knee.position.set(0, -0.4, 0);
    knee.add(box(legW, 0.38, isFemale ? 0.18 : 0.2, lowerColor, 0, -0.19, 0));
    // Sepatu — perempuan lebih kecil dan tipis
    knee.add(box(shoeW, shoeH, 0.3, shoeColor, 0, isFemale ? -0.40 : -0.42, 0.05));
    thigh.add(knee);
    hips.add(thigh);
    legs.push({ thigh, knee });
  }

  // arms — perempuan lebih ramping
  const arms = [];
  const armW = isFemale ? 0.14 : 0.17;
  const handW = isFemale ? 0.12 : 0.14;
  for (const side of [1, -1]) {
    const pivot = new THREE.Group();
    pivot.position.set(side * armOffset, 0.53, 0);
    pivot.add(box(armW, 0.34, armW, shirt, 0, -0.17, 0));
    pivot.add(box(handW, 0.14, handW, skin, 0, -0.41, 0));
    hips.add(pivot);
    arms.push(pivot);
  }

  // hit area (klik & hover lebih gampang dan responsif)
  const hit = new THREE.Mesh(
    new THREE.BoxGeometry(1.4, 2.2, 1.4),
    new THREE.MeshBasicMaterial({ visible: false }),
  );
  hit.position.set(0, 0.95, 0.1);
  hit.userData.agentId = agent.id;
  root.add(hit);

  const seed = (index + 1) * 1.7 + agent.name.length;
  const c = {
    agent,
    root,
    hit,
    head,
    status: 'idle', // idle | working | done
    selected: false,
    sit: 1,
    sitTarget: 1,
    walk: 0,
    heading: 0,
    home: new THREE.Vector3(),
    path: [],
    routine: 'seated',
    routineT: 3 + Math.random() * 10,
    roams: false,
    roamPath: [],
    actionT: 0,
    action: null,
    phase: Math.random() * 6,
    seed,
    inPantry: false,
    isPantryBreak: false,
  };

  c.setHome = (x, y, z) => {
    c.home.set(x, y, z);
    root.position.set(x, y, z);
  };
  c.wave = () => {
    c.action = 'wave';
    c.actionT = 1.4;
  };
  c.drink = () => {
    c.action = 'drink';
    c.actionT = 2.5;
  };
  c.headAnchor = (out) => {
    head.getWorldPosition(out);
    out.y += 0.62;
    return out;
  };

  function startWalk(points) {
    c.path = points.map((p) => new THREE.Vector3(p[0], c.home.y, p[1]));
    c.sitTarget = 0;
  }

  c.update = (dt, t) => {
    c.sit = damp(c.sit, c.sitTarget, 7, dt);
    const sitting = c.sit;
    const busy = c.status === 'working' || c.selected;

    // ---- rutinitas (stretching di meja & jalan ke pantry) ----
    if (c.routine === 'seated') {
      c.routineT -= dt;
      if (c.routineT <= 0 && !busy && !c.action) {
        // Rutinitas: dominan stretching (65%), sesekali break jalan ke pantry (35%)
        const shouldWalkToPantry = c.roams && c.roamPath.length && (Math.random() < 0.35);
        if (shouldWalkToPantry) {
          c.routine = 'rising';
          startWalk(c.roamPath);
        } else {
          // Melakukan stretching / regangan di meja kerja
          c.action = 'stretch';
          c.actionT = 2.4;
          c.routineT = 10 + Math.random() * 15;
        }
      }
    } else if (c.routine === 'rising') {
      if (c.sit < 0.08) c.routine = 'out';
    } else if (c.routine === 'out' || c.routine === 'back') {
      const target = c.path[0];
      if (target) {
        const dx = target.x - root.position.x;
        const dz = target.z - root.position.z;
        const dist = Math.hypot(dx, dz);
        const step = 1.5 * dt;
        if (dist <= step) {
          root.position.set(target.x, c.home.y, target.z);
          c.path.shift();
        } else {
          root.position.x += (dx / dist) * step;
          root.position.z += (dz / dist) * step;
          const want = Math.atan2(dx, dz);
          let diff = want - c.heading;
          diff = Math.atan2(Math.sin(diff), Math.cos(diff));
          c.heading += diff * Math.min(1, dt * 9);
        }
        c.walk = damp(c.walk, 1, 10, dt);
      } else {
        c.walk = damp(c.walk, 0, 12, dt);
        if (c.routine === 'out') {
          c.routine = 'pause';
          c.routineT = c.isPantryBreak ? (12 + Math.random() * 8) : (3 + Math.random() * 4);
          if (c.isPantryBreak) {
            c.inPantry = true;
            // Aksi awal saat sampai di pantry: minum kopi / wave
            setTimeout(() => { if (c.inPantry) c.drink(); }, 600);
          }
        } else {
          c.routine = 'sitting';
          c.sitTarget = 1;
        }
      }
      if (c.routine === 'out' && busy) {
        // dipanggil kerja/di-klik: langsung balik ke meja
        c.inPantry = false;
        c.routine = 'back';
        c.path = [...roamBack()];
      }
    } else if (c.routine === 'pause') {
      c.walk = damp(c.walk, 0, 12, dt);
      c.routineT -= dt;
      if (c.isPantryBreak && !c.action && Math.random() < 0.02) {
        if (Math.random() < 0.6) c.drink();
        else c.wave();
      }
      if (c.routineT <= 0 || busy) {
        c.inPantry = false;
        c.routine = 'back';
        c.path = [...roamBack()];
      }
    } else if (c.routine === 'sitting') {
      c.walk = damp(c.walk, 0, 12, dt);
      c.heading = damp(c.heading, 0, 8, dt);
      if (c.sit > 0.97) {
        c.sit = 1;
        c.routine = 'seated';
        c.inPantry = false;
        c.routineT = 40 + Math.random() * 60;
        root.position.set(c.home.x, c.home.y, c.home.z);
      }
    }

    function roamBack() {
      const pts = c.roamPath.slice(0, -1).reverse().map((p) => new THREE.Vector3(p[0], c.home.y, p[1]));
      pts.push(new THREE.Vector3(c.home.x, c.home.y, c.home.z));
      return pts;
    }

    // ---- pose ----
    root.rotation.y = c.routine === 'seated' || c.routine === 'sitting' ? damp(root.rotation.y, 0, 8, dt) : c.heading;
    const hipY = lerp(0.84, 0.55, sitting);
    // 4D: Breathing lebih terasa — amplitudo berbeda saat working vs idle
    const working = c.status === 'working';
    const breathAmp = working ? 0.014 : 0.009;
    const breathFreq = working ? 2.8 : 1.8;
    const breathe = Math.sin(t * breathFreq + c.seed) * breathAmp;
    // 4D: Micro-sway kiri-kanan saat duduk idle (seperti orang yang tidak bisa diam)
    const idleSway = c.selected || working ? 0 : Math.sin(t * 0.4 + c.seed * 1.3) * 0.012 * sitting;
    hips.position.y = hipY + breathe;
    hips.position.x = damp(hips.position.x, idleSway, 3, dt);

    const swing = Math.sin(t * 8 + c.phase) * 0.7 * c.walk;
    legs[0].thigh.rotation.x = -Math.PI / 2 * sitting + swing * (1 - sitting);
    legs[1].thigh.rotation.x = -Math.PI / 2 * sitting - swing * (1 - sitting);
    legs[0].knee.rotation.x = Math.PI / 2 * sitting + Math.max(0, -swing) * 0.6;
    legs[1].knee.rotation.x = Math.PI / 2 * sitting + Math.max(0, swing) * 0.6;

    const typeSpeed = working ? 16 : 7;
    const typeAmp = working ? 0.12 : 0.04;
    const armsSeated = -1.1;
    let aL = lerp(0, armsSeated + Math.sin(t * typeSpeed + 1) * typeAmp, sitting);
    let aR = lerp(0, armsSeated + Math.sin(t * typeSpeed + 3) * typeAmp, sitting);
    aL += -swing * 0.9 * (1 - sitting);
    aR += swing * 0.9 * (1 - sitting);
    let zL = 0;
    let zR = 0;

    if (c.action) {
      c.actionT -= dt;
      const k = clamp(Math.min(c.actionT, 1.4 - c.actionT + 0.2) * 3, 0, 1);
      if (c.action === 'wave') {
        zR = (2.4 + Math.sin(t * 11) * 0.3) * k;
        aR = lerp(aR, 0, k);
      } else if (c.action === 'stretch') {
        aL = lerp(aL, -3.0, k);
        aR = lerp(aR, -3.0, k);
      } else if (c.action === 'drink') {
        // Angkat cangkir ke mulut saat di pantry
        aR = lerp(aR, -2.1, k);
        zR = (0.55 + Math.sin(t * 6) * 0.1) * k;
      }
      if (c.actionT <= 0) c.action = null;
    }
    arms[0].rotation.set(aR, 0, zR);
    arms[1].rotation.set(aL, 0, -zL);

    const look = Math.sin(t * 0.55 + c.seed) * (working ? 0.1 : 0.3);
    head.rotation.y = damp(head.rotation.y, c.selected ? 0 : look, 5, dt);
    head.rotation.x = damp(head.rotation.x, working ? 0.18 : 0.03, 5, dt);
  };

  return c;
}
