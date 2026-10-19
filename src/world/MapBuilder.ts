import * as THREE from 'three';
import { MapId } from '../data/bodycamData';

export interface ReactiveTarget {
  id: string;
  root: THREE.Group;
  pivot: THREE.Group;
  headMesh: THREE.Mesh;
  bodyMesh: THREE.Mesh;
  distanceMeters: number;
  laneIndex: number;
  isMoving: boolean;
  moveOriginX: number;
  moveAmp: number;
  moveSpeed: number;
  movePhase: number;
  isDown: boolean;
  downTimer: number;
  isDrillTarget?: boolean;
  drillActive?: boolean;
}

export interface BuiltMap {
  sceneGroup: THREE.Group;
  colliders: THREE.Box3[];
  raycastMeshes: THREE.Object3D[];
  reactiveTargets: ReactiveTarget[];
  playerSpawn: THREE.Vector3;
  playerSpawnYaw: number;
  botWaypoints: THREE.Vector3[];
  bombSites: { name: string; position: THREE.Vector3 }[];
  surfaceType: 'CONCRETE' | 'WOOD' | 'MUD';
  defaultExposure: number;
}

export class MapBuilder {
  private static texCache: Record<string, THREE.CanvasTexture> = {};

  private static makeProceduralTexture(
    key: string,
    drawFn: (ctx: CanvasRenderingContext2D, w: number, h: number) => void,
    repeatX = 4,
    repeatY = 4
  ): THREE.CanvasTexture {
    const cacheKey = `${key}_${repeatX}_${repeatY}`;
    if (this.texCache[cacheKey]) return this.texCache[cacheKey];

    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 256;
    const ctx = canvas.getContext('2d')!;
    drawFn(ctx, 256, 256);

    const tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(repeatX, repeatY);
    this.texCache[cacheKey] = tex;
    return tex;
  }

  public static getConcreteTex(rx = 6, ry = 6): THREE.CanvasTexture {
    return this.makeProceduralTexture(
      'concrete',
      (ctx, w, h) => {
        ctx.fillStyle = '#3a3d42';
        ctx.fillRect(0, 0, w, h);
        for (let i = 0; i < 4000; i++) {
          const v = 45 + Math.floor(Math.random() * 35);
          ctx.fillStyle = `rgb(${v},${v + 2},${v + 5})`;
          ctx.fillRect(Math.random() * w, Math.random() * h, 2, 2);
        }
        ctx.strokeStyle = 'rgba(20,22,25,0.45)';
        ctx.lineWidth = 2;
        ctx.strokeRect(1, 1, w - 2, h - 2);
      },
      rx,
      ry
    );
  }

  public static getPlywoodTex(rx = 2, ry = 2): THREE.CanvasTexture {
    return this.makeProceduralTexture(
      'plywood',
      (ctx, w, h) => {
        ctx.fillStyle = '#7c5d3b';
        ctx.fillRect(0, 0, w, h);
        for (let y = 0; y < h; y += 3) {
          const shade = Math.sin(y * 0.08) * 12 + (Math.random() - 0.5) * 10;
          ctx.fillStyle = `rgb(${124 + shade}, ${93 + shade * 0.8}, ${59 + shade * 0.5})`;
          ctx.fillRect(0, y, w, 3);
        }
        ctx.strokeStyle = 'rgba(40,28,15,0.5)';
        ctx.lineWidth = 4;
        ctx.strokeRect(2, 2, w - 4, h - 4);
      },
      rx,
      ry
    );
  }

  public static getMudTex(rx = 8, ry = 8): THREE.CanvasTexture {
    return this.makeProceduralTexture(
      'mud',
      (ctx, w, h) => {
        ctx.fillStyle = '#2d241c';
        ctx.fillRect(0, 0, w, h);
        for (let i = 0; i < 3500; i++) {
          const r = 32 + Math.floor(Math.random() * 28);
          ctx.fillStyle = `rgb(${r + 8},${r},${r - 6})`;
          ctx.fillRect(Math.random() * w, Math.random() * h, 3, 3);
        }
      },
      rx,
      ry
    );
  }

  public static getContainerTex(baseHex: string, rx = 2, ry = 1): THREE.CanvasTexture {
    return this.makeProceduralTexture(
      `container_${baseHex}`,
      (ctx, w, h) => {
        ctx.fillStyle = baseHex;
        ctx.fillRect(0, 0, w, h);
        for (let x = 0; x < w; x += 16) {
          ctx.fillStyle = 'rgba(0,0,0,0.22)';
          ctx.fillRect(x, 0, 6, h);
          ctx.fillStyle = 'rgba(255,255,255,0.08)';
          ctx.fillRect(x + 6, 0, 4, h);
        }
      },
      rx,
      ry
    );
  }

  public static getTargetSilhouetteTex(isThreat = true): THREE.CanvasTexture {
    return this.makeProceduralTexture(
      `target_${isThreat}`,
      (ctx, w, h) => {
        ctx.fillStyle = isThreat ? '#181c20' : '#1f3a52';
        ctx.fillRect(0, 0, w, h);
        ctx.strokeStyle = '#e5e7eb';
        ctx.lineWidth = 5;
        ctx.strokeRect(8, 8, w - 16, h - 16);

        // Scoring rings on chest
        const cx = w / 2;
        const cy = h * 0.45;
        [75, 52, 30].forEach((r, idx) => {
          ctx.beginPath();
          ctx.arc(cx, cy, r, 0, Math.PI * 2);
          ctx.strokeStyle = idx === 2 ? '#ef4444' : 'rgba(255,255,255,0.45)';
          ctx.lineWidth = idx === 2 ? 4 : 2;
          ctx.stroke();
        });
        ctx.fillStyle = '#ef4444';
        ctx.beginPath();
        ctx.arc(cx, cy, 10, 0, Math.PI * 2);
        ctx.fill();
      },
      1,
      1
    );
  }

  public static buildMap(mapId: MapId, scene: THREE.Scene): BuiltMap {
    const sceneGroup = new THREE.Group();
    const colliders: THREE.Box3[] = [];
    const raycastMeshes: THREE.Object3D[] = [];
    const reactiveTargets: ReactiveTarget[] = [];
    const botWaypoints: THREE.Vector3[] = [];
    const bombSites: { name: string; position: THREE.Vector3 }[] = [];

    const addBox = (
      w: number,
      h: number,
      d: number,
      x: number,
      y: number,
      z: number,
      mat: THREE.Material,
      hasCollision = true
    ): THREE.Mesh => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
      mesh.position.set(x, y, z);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      sceneGroup.add(mesh);
      raycastMeshes.push(mesh);
      if (hasCollision) {
        const box = new THREE.Box3().setFromObject(mesh);
        colliders.push(box);
      }
      return mesh;
    };

    const createReactiveTarget = (
      id: string,
      x: number,
      y: number,
      z: number,
      distanceMeters: number,
      laneIndex: number,
      isMoving = false,
      moveAmp = 2.5,
      moveSpeed = 1.4,
      isDrillTarget = false
    ): ReactiveTarget => {
      const root = new THREE.Group();
      root.position.set(x, y, z);
      sceneGroup.add(root);

      const standMat = new THREE.MeshStandardMaterial({
        color: 0x2c3035,
        roughness: 0.5,
        metalness: 0.7,
      });
      const base = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.08, 0.7), standMat);
      base.position.set(0, 0.04, 0);
      root.add(base);

      // Distance marker plate on base
      const pivot = new THREE.Group();
      pivot.position.set(0, 0.08, 0);
      root.add(pivot);

      const post = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.9, 0.08), standMat);
      post.position.set(0, 0.45, 0);
      pivot.add(post);

      const torsoMat = new THREE.MeshStandardMaterial({
        map: this.getTargetSilhouetteTex(true),
        roughness: 0.4,
        metalness: 0.6,
      });
      const bodyMesh = new THREE.Mesh(new THREE.BoxGeometry(0.54, 0.74, 0.05), torsoMat);
      bodyMesh.position.set(0, 1.12, 0);
      bodyMesh.userData = { targetId: id, hitZone: 'BODY' };
      pivot.add(bodyMesh);
      raycastMeshes.push(bodyMesh);

      const headMat = new THREE.MeshStandardMaterial({
        color: 0xef4444,
        roughness: 0.35,
        metalness: 0.7,
      });
      const headMesh = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.26, 0.05), headMat);
      headMesh.position.set(0, 1.64, 0);
      headMesh.userData = { targetId: id, hitZone: 'HEAD' };
      pivot.add(headMesh);
      raycastMeshes.push(headMesh);

      if (isDrillTarget) {
        pivot.rotation.x = -Math.PI / 2;
      }

      const rt: ReactiveTarget = {
        id,
        root,
        pivot,
        headMesh,
        bodyMesh,
        distanceMeters,
        laneIndex,
        isMoving,
        moveOriginX: x,
        moveAmp,
        moveSpeed,
        movePhase: Math.random() * Math.PI * 2,
        isDown: isDrillTarget,
        downTimer: 0,
        isDrillTarget,
        drillActive: false,
      };
      reactiveTargets.push(rt);
      return rt;
    };

    if (mapId === 'SHOOTING_RANGE') {
      // ==================== MAP 1: v0.8 SHOOTING RANGE & CQB KILLHOUSE HUB ====================
      scene.background = new THREE.Color(0x11151a);
      scene.fog = new THREE.FogExp2(0x11151a, 0.011);

      const floorMat = new THREE.MeshStandardMaterial({
        map: this.getConcreteTex(18, 24),
        roughness: 0.65,
        metalness: 0.15,
      });
      const wallMat = new THREE.MeshStandardMaterial({
        map: this.getConcreteTex(10, 4),
        color: 0x777d84,
        roughness: 0.75,
      });
      const plywoodMat = new THREE.MeshStandardMaterial({
        map: this.getPlywoodTex(2, 2),
        roughness: 0.7,
      });
      const boothMat = new THREE.MeshStandardMaterial({
        color: 0x22262b,
        roughness: 0.45,
        metalness: 0.6,
      });
      const accentOrangeMat = new THREE.MeshStandardMaterial({
        color: 0xd97706,
        roughness: 0.5,
      });

      // Main Floor (covers Range on left x:[-16..10] and CQB Killhouse on right x:[10..38])
      const floor = new THREE.Mesh(new THREE.PlaneGeometry(68, 105), floorMat);
      floor.rotation.x = -Math.PI / 2;
      floor.position.set(10, 0, -32);
      floor.receiveShadow = true;
      sceneGroup.add(floor);
      raycastMeshes.push(floor);

      // Ceiling over Range Lounge & Firing Booths
      addBox(64, 0.4, 24, 10, 6.2, 4, wallMat, false);

      // Outer Perimeter Walls
      addBox(0.6, 6.5, 102, -16, 3.25, -32, wallMat); // West wall
      addBox(0.6, 6.5, 102, 38, 3.25, -32, wallMat); // East wall
      addBox(55, 6.5, 0.6, 11, 3.25, 14, wallMat); // South back wall behind Armory lounge
      addBox(55, 6.5, 0.6, 11, 3.25, -82, wallMat); // North 75m backstop berm

      // Divider wall between Firing Lanes (x < 9) and CQB Killhouse Wing (x > 9) with wide breach doorway at z = 4..9
      addBox(0.5, 5.5, 76, 9, 2.75, -42, wallMat);

      // Firing Line Counter & Dividers at z = 0 (with walkthrough gate on left x = -13.5)
      addBox(19.5, 1.05, 0.7, -1, 0.52, 0, boothMat); // Waist-high shooting bench
      // Lane dividers
      [-11, -6, -1, 4, 8.8].forEach((lx) => {
        addBox(0.15, 2.6, 2.2, lx, 1.3, 0.4, boothMat);
      });

      // Armory Weapon Rack & Briefing Table in Lounge behind firing line (z = 6..12)
      addBox(8, 0.9, 1.4, -3, 0.45, 9.5, plywoodMat);
      addBox(12, 2.8, 0.3, -3, 1.4, 13.4, boothMat);

      // Distance Markers on Range Floor (10m, 25m, 50m, 75m)
      [-10, -25, -50, -75].forEach((mz) => {
        addBox(24, 0.03, 0.25, -3.5, 0.015, mz, accentOrangeMat, false);
      });

      // Populate Calibrated Reactive Steel Targets across the 4 Lanes!
      // Lane 1 (x = -8.5): 10m & 25m CQB Precision
      createReactiveTarget('t_10m_L1', -8.5, 0, -10, 10, 1, false);
      createReactiveTarget('t_20m_L1', -9.8, 0, -20, 20, 1, false);

      // Lane 2 (x = -3.5): 15m Moving Lateral Target & 25m Standard
      createReactiveTarget('t_15m_move', -3.5, 0, -15, 15, 2, true, 2.2, 1.65);
      createReactiveTarget('t_25m_L2', -3.5, 0, -25, 25, 2, false);

      // Lane 3 (x = 1.5): 25m Moving & 50m Mid-Range Marksman
      createReactiveTarget('t_28m_move', 1.5, 0, -28, 28, 3, true, 2.8, 1.35);
      createReactiveTarget('t_50m_L3', 1.5, 0, -50, 50, 3, false);

      // Lane 4 (x = 6.2): 50m & 75m Long-Range Sniper Calibration
      createReactiveTarget('t_40m_L4', 6.2, 0, -40, 40, 4, false);
      createReactiveTarget('t_75m_L4', 6.2, 0, -75, 75, 4, false);

      // Timed Reflex Drill Pop-Up Targets (scattered from 8m to 32m)
      const drillCoords = [
        [-10.5, -8],
        [-6.2, -12],
        [-1.0, -11],
        [4.2, -13],
        [-7.5, -18],
        [-2.2, -22],
        [3.5, -20],
        [6.8, -26],
      ];
      drillCoords.forEach(([dx, dz], idx) => {
        createReactiveTarget(
          `drill_${idx}`,
          dx,
          0,
          dz,
          Math.abs(dz),
          0,
          idx % 3 === 0,
          1.4,
          2.0,
          true
        );
      });

      // ==================== CONNECTED CQB KILLHOUSE BREACHING WING (x: 10..36, z: 10..-65) ====================
      // Plywood rooms, angled corners for Q/E leaning, cover crates, and AI bot patrol routes!
      addBox(8, 3.4, 0.35, 14, 1.7, -4, plywoodMat);
      addBox(8, 3.4, 0.35, 28, 1.7, -4, plywoodMat);

      addBox(0.35, 3.4, 14, 21, 1.7, -14, plywoodMat);
      addBox(9, 3.4, 0.35, 15, 1.7, -18, plywoodMat);
      addBox(9, 3.4, 0.35, 31, 1.7, -18, plywoodMat);

      // Cover crates inside Killhouse
      addBox(1.8, 1.3, 1.8, 15, 0.65, -10, accentOrangeMat);
      addBox(2.2, 1.4, 1.4, 28, 0.7, -12, boothMat);
      addBox(1.8, 1.3, 1.8, 18, 0.65, -26, accentOrangeMat);
      addBox(2.4, 2.8, 2.4, 27, 1.4, -28, plywoodMat);
      addBox(9, 3.4, 0.35, 16, 1.7, -35, plywoodMat);
      addBox(9, 3.4, 0.35, 30, 1.7, -35, plywoodMat);
      addBox(2.0, 1.3, 2.0, 23, 0.65, -44, boothMat);

      // Lighting
      const amb = new THREE.AmbientLight(0xdbeafe, 0.65);
      sceneGroup.add(amb);

      const dirLight = new THREE.DirectionalLight(0xfffbeb, 1.25);
      dirLight.position.set(12, 28, 10);
      dirLight.castShadow = true;
      sceneGroup.add(dirLight);

      // Warm industrial spot lights over firing line & killhouse
      [
        [-4, 5.5, 2],
        [4, 5.5, 2],
        [-3, 8, -22],
        [22, 5.5, -12],
        [22, 5.5, -32],
      ].forEach(([lx, ly, lz]) => {
        const pt = new THREE.PointLight(0xffedd5, 1.4, 28, 1.5);
        pt.position.set(lx, ly, lz);
        sceneGroup.add(pt);
      });

      // Bot Waypoints in the CQB Killhouse Wing & Downrange
      botWaypoints.push(
        new THREE.Vector3(15, 0, -8),
        new THREE.Vector3(29, 0, -9),
        new THREE.Vector3(16, 0, -22),
        new THREE.Vector3(29, 0, -23),
        new THREE.Vector3(23, 0, -31),
        new THREE.Vector3(15, 0, -40),
        new THREE.Vector3(30, 0, -42),
        new THREE.Vector3(22, 0, -15)
      );

      bombSites.push(
        { name: 'KILLHOUSE ROOM A', position: new THREE.Vector3(16, 0, -14) },
        { name: 'KILLHOUSE BREACH B', position: new THREE.Vector3(28, 0, -30) }
      );

      return {
        sceneGroup,
        colliders,
        raycastMeshes,
        reactiveTargets,
        playerSpawn: new THREE.Vector3(-2.5, 0, 3.2),
        playerSpawnYaw: 0, // Facing North (-Z) toward firing lanes
        botWaypoints,
        bombSites,
        surfaceType: 'CONCRETE',
        defaultExposure: 1.12,
      };
    }

    if (mapId === 'CQB_POWERGUN') {
      // ==================== MAP 2: CQB POWERGUN WAREHOUSE ====================
      scene.background = new THREE.Color(0x0b0e13);
      scene.fog = new THREE.FogExp2(0x0b0e13, 0.022);

      const floorMat = new THREE.MeshStandardMaterial({
        map: this.getConcreteTex(16, 16),
        color: 0x555b62,
        roughness: 0.7,
      });
      const wallMat = new THREE.MeshStandardMaterial({
        map: this.getConcreteTex(12, 4),
        color: 0x3f444a,
        roughness: 0.8,
      });
      const blueContainerMat = new THREE.MeshStandardMaterial({
        map: this.getContainerTex('#1e3a5f'),
        roughness: 0.5,
        metalness: 0.55,
      });
      const redContainerMat = new THREE.MeshStandardMaterial({
        map: this.getContainerTex('#6b2121'),
        roughness: 0.5,
        metalness: 0.55,
      });
      const plywoodMat = new THREE.MeshStandardMaterial({
        map: this.getPlywoodTex(2, 2),
        roughness: 0.72,
      });

      const floor = new THREE.Mesh(new THREE.PlaneGeometry(56, 56), floorMat);
      floor.rotation.x = -Math.PI / 2;
      floor.receiveShadow = true;
      sceneGroup.add(floor);
      raycastMeshes.push(floor);

      // Warehouse Ceiling
      addBox(56, 0.5, 56, 0, 8.5, 0, wallMat, false);

      // Outer Walls
      addBox(56, 8.5, 0.6, 0, 4.25, -28, wallMat);
      addBox(56, 8.5, 0.6, 0, 4.25, 28, wallMat);
      addBox(0.6, 8.5, 56, -28, 4.25, 0, wallMat);
      addBox(0.6, 8.5, 56, 28, 4.25, 0, wallMat);

      // Shipping Containers & Central Plywood Killhouse
      addBox(3.2, 3.0, 8.5, -12, 1.5, -10, blueContainerMat);
      addBox(3.2, 3.0, 8.5, 12, 1.5, 10, redContainerMat);
      addBox(8.5, 3.0, 3.2, -10, 1.5, 12, redContainerMat);
      addBox(8.5, 3.0, 3.2, 11, 1.5, -13, blueContainerMat);

      // Central CQB Plywood Room with doorway gaps
      addBox(8, 3.4, 0.35, -3.5, 1.7, -4.5, plywoodMat);
      addBox(8, 3.4, 0.35, 3.5, 1.7, 4.5, plywoodMat);
      addBox(0.35, 3.4, 7, -6.5, 1.7, 1, plywoodMat);
      addBox(0.35, 3.4, 7, 6.5, 1.7, -1, plywoodMat);

      // Concrete Pillars & Waist-high Tactical Barricades
      [
        [-18, -18],
        [18, -18],
        [-18, 18],
        [18, 18],
        [0, -16],
        [0, 16],
      ].forEach(([px, pz]) => {
        addBox(1.8, 8.5, 1.8, px, 4.25, pz, wallMat);
      });

      [
        [-5, 0, -12],
        [5, 0, 12],
        [-15, 0, 0],
        [15, 0, 0],
        [0, 0, 0],
      ].forEach(([cx, _, cz]) => {
        addBox(2.2, 1.25, 1.2, cx, 0.625, cz, plywoodMat);
      });

      // Practice Silhouette Targets in North Alcove
      createReactiveTarget('cqb_t1', -6, 0, -24, 24, 1, false);
      createReactiveTarget('cqb_t2', 6, 0, -24, 24, 2, true, 2.5, 1.5);

      // Moody Warehouse Lighting (Flashlight [F] makes a huge difference in dark corners!)
      const amb = new THREE.AmbientLight(0x8fa8c8, 0.38);
      sceneGroup.add(amb);

      [
        [0, 7.2, 0, 0xffd8a8, 1.6],
        [-14, 7.2, -14, 0xa8d0ff, 1.1],
        [14, 7.2, 14, 0xffb878, 1.2],
        [-14, 7.2, 14, 0xd8e8ff, 0.9],
        [14, 7.2, -14, 0xffd8a8, 1.1],
      ].forEach(([lx, ly, lz, col, inten]) => {
        const pt = new THREE.PointLight(col, inten, 28, 1.6);
        pt.position.set(lx, ly, lz);
        sceneGroup.add(pt);
      });

      botWaypoints.push(
        new THREE.Vector3(-16, 0, -8),
        new THREE.Vector3(16, 0, 8),
        new THREE.Vector3(0, 0, -9),
        new THREE.Vector3(0, 0, 9),
        new THREE.Vector3(-9, 0, 6),
        new THREE.Vector3(9, 0, -6),
        new THREE.Vector3(-18, 0, 14),
        new THREE.Vector3(18, 0, -14),
        new THREE.Vector3(0, 0, -20)
      );

      bombSites.push(
        { name: 'SITE A (KILLHOUSE CENTER)', position: new THREE.Vector3(0, 0, 0) },
        { name: 'SITE B (NORTH CONTAINER)', position: new THREE.Vector3(8, 0, -16) }
      );

      return {
        sceneGroup,
        colliders,
        raycastMeshes,
        reactiveTargets,
        playerSpawn: new THREE.Vector3(0, 0, 22),
        playerSpawnYaw: 0,
        botWaypoints,
        bombSites,
        surfaceType: 'CONCRETE',
        defaultExposure: 1.05,
      };
    }

    // ==================== MAP 3: TRENCHES (v0.8 LOCKED & LOADED OUTDOOR BATTLEFIELD) ====================
    scene.background = new THREE.Color(0x525b63);
    scene.fog = new THREE.FogExp2(0x525b63, 0.018);

    const mudMat = new THREE.MeshStandardMaterial({
      map: this.getMudTex(20, 20),
      roughness: 0.9,
      metalness: 0.05,
    });
    const woodMat = new THREE.MeshStandardMaterial({
      map: this.getPlywoodTex(3, 1),
      color: 0x5c442c,
      roughness: 0.85,
    });
    const stoneMat = new THREE.MeshStandardMaterial({
      map: this.getConcreteTex(8, 4),
      color: 0x62666a,
      roughness: 0.85,
    });
    const sandbagMat = new THREE.MeshStandardMaterial({
      color: 0x786f56,
      roughness: 0.9,
    });

    const floor = new THREE.Mesh(new THREE.PlaneGeometry(76, 76), mudMat);
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    sceneGroup.add(floor);
    raycastMeshes.push(floor);

    // Outer Minefield / Berm Perimeter
    addBox(76, 4.5, 1.5, 0, 2.25, -38, mudMat);
    addBox(76, 4.5, 1.5, 0, 2.25, 38, mudMat);
    addBox(1.5, 4.5, 76, -38, 2.25, 0, mudMat);
    addBox(1.5, 4.5, 76, 38, 2.25, 0, mudMat);

    // Wooden Duckboard Walkways in Trench Floor
    [-18, 0, 18].forEach((tz) => {
      addBox(42, 0.06, 1.8, 0, 0.03, tz, woodMat, false);
    });

    // Fortified Trench Walls & Sandbag Parapets
    const trenchBlocks = [
      // South Trench Line
      [-14, 15, 12, 2.1, 1.6],
      [14, 15, 12, 2.1, 1.6],
      // Mid Trench Bunkers
      [-18, 0, 6, 2.3, 8],
      [18, 0, 6, 2.3, 8],
      // North Trench Line
      [-14, -15, 12, 2.1, 1.6],
      [14, -15, 12, 2.1, 1.6],
    ];
    trenchBlocks.forEach(([bx, bz, bw, bh, bd]) => {
      addBox(bw, bh, bd, bx, bh * 0.5, bz, woodMat);
      addBox(bw * 0.9, 0.55, bd * 0.8, bx, bh + 0.25, bz, sandbagMat);
    });

    // Central Ruined Church Sanctuary & Bell Tower Remnant (Signature v0.8 Trenches landmark!)
    addBox(9, 4.2, 0.7, -4.5, 2.1, -5, stoneMat);
    addBox(9, 4.2, 0.7, 4.5, 2.1, 5, stoneMat);
    addBox(0.7, 4.2, 8, -8.5, 2.1, 1, stoneMat);
    addBox(0.7, 4.2, 8, 8.5, 2.1, -1, stoneMat);
    // Ruined Bell Tower Column
    addBox(2.8, 9.5, 2.8, -7.5, 4.75, -4.5, stoneMat);

    // Dead Battlefield Trees around edges
    const trunkMat = new THREE.MeshStandardMaterial({ color: 0x2b2118, roughness: 0.95 });
    [
      [-26, -24],
      [25, -22],
      [-28, 12],
      [27, 16],
      [-22, 26],
      [24, 25],
      [0, -28],
    ].forEach(([tx, tz]) => {
      const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.42, 6.5, 7), trunkMat);
      trunk.position.set(tx, 3.25, tz);
      trunk.castShadow = true;
      sceneGroup.add(trunk);
      raycastMeshes.push(trunk);
      colliders.push(new THREE.Box3().setFromObject(trunk));
    });

    // Long-range Field Targets in North No-Man's-Land
    createReactiveTarget('trench_t1', -8, 0, -29, 55, 1, false);
    createReactiveTarget('trench_t2', 8, 0, -29, 55, 2, true, 3.2, 1.3);

    // Overcast Sky Daylight + Sun
    const hemi = new THREE.HemisphereLight(0x9fb0c2, 0x3d332a, 1.15);
    sceneGroup.add(hemi);

    const sun = new THREE.DirectionalLight(0xeef2f6, 1.35);
    sun.position.set(-25, 40, 20);
    sun.castShadow = true;
    sceneGroup.add(sun);

    botWaypoints.push(
      new THREE.Vector3(-12, 0, -22),
      new THREE.Vector3(12, 0, -22),
      new THREE.Vector3(0, 0, -10),
      new THREE.Vector3(-10, 0, 0),
      new THREE.Vector3(10, 0, 0),
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(-14, 0, 10),
      new THREE.Vector3(14, 0, 10),
      new THREE.Vector3(0, 0, 20)
    );

    bombSites.push(
      { name: 'RUINED CHURCH ALTAR (A)', position: new THREE.Vector3(0, 0, 0) },
      { name: 'NORTH DRONE BUNKER (B)', position: new THREE.Vector3(-14, 0, -18) }
    );

    return {
      sceneGroup,
      colliders,
      raycastMeshes,
      reactiveTargets,
      playerSpawn: new THREE.Vector3(0, 0, 28),
      playerSpawnYaw: 0,
      botWaypoints,
      bombSites,
      surfaceType: 'MUD',
      defaultExposure: 1.08,
    };
  }
}
