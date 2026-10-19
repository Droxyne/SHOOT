import {
  Color3,
  Color4,
  DirectionalLight,
  DynamicTexture,
  HemisphericLight,
  Mesh,
  MeshBuilder,
  PBRMaterial,
  PointLight,
  Scene,
  StandardMaterial,
  TransformNode,
  Vector3,
} from '@babylonjs/core';
import { MapId } from '../data/bodycamData';

export interface ReactiveTarget {
  id: string;
  root: TransformNode;
  pivot: TransformNode;
  headMesh: Mesh;
  bodyMesh: Mesh;
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
  sceneGroup: TransformNode;
  reactiveTargets: ReactiveTarget[];
  playerSpawn: Vector3;
  playerSpawnYaw: number;
  botWaypoints: Vector3[];
  bombSites: { name: string; position: Vector3 }[];
  surfaceType: 'CONCRETE' | 'WOOD' | 'MUD';
  defaultExposure: number;
}

export class MapBuilder {
  private static texCache: Record<string, DynamicTexture> = {};

  private static makeDynamicTexture(
    scene: Scene,
    key: string,
    drawFn: (ctx: CanvasRenderingContext2D, w: number, h: number) => void,
    uScale = 4,
    vScale = 4
  ): DynamicTexture {
    const cacheKey = `${key}_${uScale}_${vScale}`;
    if (this.texCache[cacheKey]) return this.texCache[cacheKey];

    const dt = new DynamicTexture(cacheKey, { width: 256, height: 256 }, scene, true);
    const ctx = dt.getContext() as unknown as CanvasRenderingContext2D;
    drawFn(ctx, 256, 256);
    dt.update();
    dt.wrapU = DynamicTexture.WRAP_ADDRESSMODE;
    dt.wrapV = DynamicTexture.WRAP_ADDRESSMODE;
    dt.uScale = uScale;
    dt.vScale = vScale;
    this.texCache[cacheKey] = dt;
    return dt;
  }

  public static getConcreteTex(scene: Scene, u = 8, v = 8): DynamicTexture {
    return this.makeDynamicTexture(
      scene,
      'concrete',
      (ctx, w, h) => {
        ctx.fillStyle = '#3b4046';
        ctx.fillRect(0, 0, w, h);
        for (let i = 0; i < 4500; i++) {
          const c = 44 + Math.floor(Math.random() * 34);
          ctx.fillStyle = `rgb(${c},${c + 2},${c + 5})`;
          ctx.fillRect(Math.random() * w, Math.random() * h, 2, 2);
        }
        ctx.strokeStyle = 'rgba(18,20,24,0.55)';
        ctx.lineWidth = 3;
        ctx.strokeRect(2, 2, w - 4, h - 4);
      },
      u,
      v
    );
  }

  public static getPlywoodTex(scene: Scene, u = 2, v = 2): DynamicTexture {
    return this.makeDynamicTexture(
      scene,
      'plywood',
      (ctx, w, h) => {
        ctx.fillStyle = '#7e5f3d';
        ctx.fillRect(0, 0, w, h);
        for (let y = 0; y < h; y += 3) {
          const s = Math.sin(y * 0.08) * 14 + (Math.random() - 0.5) * 10;
          ctx.fillStyle = `rgb(${126 + s}, ${95 + s * 0.8}, ${61 + s * 0.5})`;
          ctx.fillRect(0, y, w, 3);
        }
        ctx.strokeStyle = 'rgba(38,26,14,0.6)';
        ctx.lineWidth = 4;
        ctx.strokeRect(2, 2, w - 4, h - 4);
      },
      u,
      v
    );
  }

  public static getMudTex(scene: Scene, u = 12, v = 12): DynamicTexture {
    return this.makeDynamicTexture(
      scene,
      'mud',
      (ctx, w, h) => {
        ctx.fillStyle = '#2d241c';
        ctx.fillRect(0, 0, w, h);
        for (let i = 0; i < 4000; i++) {
          const r = 30 + Math.floor(Math.random() * 28);
          ctx.fillStyle = `rgb(${r + 8},${r},${r - 6})`;
          ctx.fillRect(Math.random() * w, Math.random() * h, 3, 3);
        }
      },
      u,
      v
    );
  }

  public static getContainerTex(scene: Scene, baseHex: string, u = 2, v = 1): DynamicTexture {
    return this.makeDynamicTexture(
      scene,
      `container_${baseHex}`,
      (ctx, w, h) => {
        ctx.fillStyle = baseHex;
        ctx.fillRect(0, 0, w, h);
        for (let x = 0; x < w; x += 16) {
          ctx.fillStyle = 'rgba(0,0,0,0.28)';
          ctx.fillRect(x, 0, 6, h);
          ctx.fillStyle = 'rgba(255,255,255,0.09)';
          ctx.fillRect(x + 6, 0, 4, h);
        }
      },
      u,
      v
    );
  }

  public static getTargetSilhouetteTex(scene: Scene): DynamicTexture {
    return this.makeDynamicTexture(
      scene,
      'targetSilhouette',
      (ctx, w, h) => {
        ctx.fillStyle = '#161a20';
        ctx.fillRect(0, 0, w, h);
        ctx.strokeStyle = '#e2e8f0';
        ctx.lineWidth = 6;
        ctx.strokeRect(8, 8, w - 16, h - 16);

        const cx = w / 2;
        const cy = h * 0.45;
        [76, 52, 28].forEach((r, idx) => {
          ctx.beginPath();
          ctx.arc(cx, cy, r, 0, Math.PI * 2);
          ctx.strokeStyle = idx === 2 ? '#ef4444' : 'rgba(255,255,255,0.5)';
          ctx.lineWidth = idx === 2 ? 5 : 2.5;
          ctx.stroke();
        });
        ctx.fillStyle = '#ef4444';
        ctx.beginPath();
        ctx.arc(cx, cy, 11, 0, Math.PI * 2);
        ctx.fill();
      },
      1,
      1
    );
  }

  public static buildMap(mapId: MapId, scene: Scene): BuiltMap {
    this.texCache = {};
    const sceneGroup = new TransformNode(`map_${mapId}`, scene);
    const reactiveTargets: ReactiveTarget[] = [];
    const botWaypoints: Vector3[] = [];
    const bombSites: { name: string; position: Vector3 }[] = [];

    const addBox = (
      w: number,
      h: number,
      d: number,
      x: number,
      y: number,
      z: number,
      mat: PBRMaterial | StandardMaterial,
      hasCollision = true
    ): Mesh => {
      const mesh = MeshBuilder.CreateBox(
        `worldBox_${x}_${z}`,
        { width: w, height: h, depth: d },
        scene
      );
      mesh.position.set(x, y, z);
      mesh.material = mat;
      mesh.parent = sceneGroup;
      mesh.checkCollisions = hasCollision;
      mesh.isPickable = true;
      mesh.metadata = { isWorldGeometry: true };
      return mesh;
    };

    const addCeilingLightFixture = (
      x: number,
      y: number,
      z: number,
      col: Color3,
      intensity = 1.65
    ) => {
      const stripMat = new StandardMaterial(`stripMat_${x}_${z}`, scene);
      stripMat.disableLighting = true;
      stripMat.emissiveColor = col.scale(2.4); // Triggers HDR Bloom!

      const fixture = MeshBuilder.CreateBox(
        `lightStrip_${x}_${z}`,
        { width: 2.2, height: 0.08, depth: 0.35 },
        scene
      );
      fixture.position.set(x, y, z);
      fixture.material = stripMat;
      fixture.parent = sceneGroup;
      fixture.isPickable = false;

      const pt = new PointLight(`ptLight_${x}_${z}`, new Vector3(x, y - 0.25, z), scene);
      pt.diffuse = col;
      pt.specular = col;
      pt.intensity = intensity;
      pt.range = 32;
      pt.parent = sceneGroup;
    };

    const createReactiveTarget = (
      id: string,
      x: number,
      y: number,
      z: number,
      distanceMeters: number,
      laneIndex: number,
      isMoving = false,
      moveAmp = 2.4,
      moveSpeed = 1.5,
      isDrillTarget = false
    ): ReactiveTarget => {
      const root = new TransformNode(`targetRoot_${id}`, scene);
      root.position.set(x, y, z);
      root.parent = sceneGroup;

      const standMat = new PBRMaterial(`standMat_${id}`, scene);
      standMat.albedoColor = new Color3(0.2, 0.22, 0.25);
      standMat.metallic = 0.78;
      standMat.roughness = 0.38;

      const base = MeshBuilder.CreateBox(
        `tBase_${id}`,
        { width: 0.7, height: 0.08, depth: 0.7 },
        scene
      );
      base.position.set(0, 0.04, 0);
      base.material = standMat;
      base.parent = root;
      base.isPickable = false;

      const pivot = new TransformNode(`tPivot_${id}`, scene);
      pivot.position.set(0, 0.08, 0);
      pivot.parent = root;

      const post = MeshBuilder.CreateBox(
        `tPost_${id}`,
        { width: 0.08, height: 0.9, depth: 0.08 },
        scene
      );
      post.position.set(0, 0.45, 0);
      post.material = standMat;
      post.parent = pivot;
      post.isPickable = false;

      const torsoMat = new PBRMaterial(`torsoMat_${id}`, scene);
      torsoMat.albedoTexture = this.getTargetSilhouetteTex(scene);
      torsoMat.metallic = 0.55;
      torsoMat.roughness = 0.35;

      const bodyMesh = MeshBuilder.CreateBox(
        `tBody_${id}`,
        { width: 0.56, height: 0.76, depth: 0.05 },
        scene
      );
      bodyMesh.position.set(0, 1.12, 0);
      bodyMesh.material = torsoMat;
      bodyMesh.parent = pivot;
      bodyMesh.isPickable = true;
      bodyMesh.metadata = { targetId: id, hitZone: 'BODY' };

      const headMat = new StandardMaterial(`headMat_${id}`, scene);
      headMat.diffuseColor = new Color3(0.95, 0.22, 0.22);
      headMat.emissiveColor = new Color3(0.65, 0.08, 0.08); // Subtle glow so headplate is readable downrange!

      const headMesh = MeshBuilder.CreateBox(
        `tHead_${id}`,
        { width: 0.25, height: 0.26, depth: 0.05 },
        scene
      );
      headMesh.position.set(0, 1.65, 0);
      headMesh.material = headMat;
      headMesh.parent = pivot;
      headMesh.isPickable = true;
      headMesh.metadata = { targetId: id, hitZone: 'HEAD' };

      if (isDrillTarget) {
        pivot.rotation.x = Math.PI / 2;
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
      scene.clearColor = new Color4(0.05, 0.065, 0.085, 1.0);
      scene.fogMode = Scene.FOGMODE_EXP2;
      scene.fogColor = new Color3(0.05, 0.065, 0.085);
      scene.fogDensity = 0.01;

      const floorMat = new PBRMaterial('rangeFloor', scene);
      floorMat.albedoTexture = this.getConcreteTex(scene, 18, 24);
      floorMat.metallic = 0.25;
      floorMat.roughness = 0.42; // Polished tactical concrete with specular highlights

      const wallMat = new PBRMaterial('rangeWall', scene);
      wallMat.albedoTexture = this.getConcreteTex(scene, 10, 4);
      wallMat.albedoColor = new Color3(0.68, 0.72, 0.76);
      wallMat.metallic = 0.12;
      wallMat.roughness = 0.68;

      const plywoodMat = new PBRMaterial('plywoodMat', scene);
      plywoodMat.albedoTexture = this.getPlywoodTex(scene, 2, 2);
      plywoodMat.metallic = 0.05;
      plywoodMat.roughness = 0.65;

      const boothMat = new PBRMaterial('boothMat', scene);
      boothMat.albedoColor = new Color3(0.14, 0.16, 0.19);
      boothMat.metallic = 0.72;
      boothMat.roughness = 0.35;

      const accentAmberMat = new StandardMaterial('accentAmber', scene);
      accentAmberMat.diffuseColor = new Color3(0.95, 0.58, 0.08);
      accentAmberMat.emissiveColor = new Color3(1.4, 0.72, 0.1); // Glowing range distance strips!

      // Main Floor (+Z is North downrange, X:[-16..10] is Range, X:[10..38] is CQB Killhouse)
      const floor = MeshBuilder.CreateGround(
        'floor',
        { width: 68, height: 110 },
        scene
      );
      floor.position.set(10, 0, 32);
      floor.material = floorMat;
      floor.parent = sceneGroup;
      floor.checkCollisions = true;
      floor.isPickable = true;
      floor.metadata = { isWorldGeometry: true };

      // Ceiling over Range Lounge & Firing Line
      addBox(64, 0.4, 24, 10, 6.2, -4, wallMat, false);

      // Outer Perimeter Walls
      addBox(0.6, 6.5, 106, -16, 3.25, 32, wallMat);
      addBox(0.6, 6.5, 106, 38, 3.25, 32, wallMat);
      addBox(55, 6.5, 0.6, 11, 3.25, -14, wallMat);
      addBox(55, 6.5, 0.6, 11, 3.25, 82, wallMat);

      // Divider wall between Firing Lanes (x < 9) and CQB Killhouse Wing (x > 9) with breach doorway at z = -9..-2
      addBox(0.5, 5.5, 76, 9, 2.75, 42, wallMat);
      // Glowing Amber Breach Frame indicating Killhouse Entrance on the right!
      addBox(0.6, 3.2, 0.25, 9, 1.6, 3.8, accentAmberMat, false);

      // Firing Line Counter at z = 0 (with open walkthrough gate on left & right)
      addBox(16.5, 1.0, 0.7, -1.5, 0.5, 0, boothMat);
      [-10, -5.5, -1, 3.5, 8.2].forEach((lx) => {
        addBox(0.14, 2.6, 2.2, lx, 1.3, -0.4, boothMat);
      });

      // Glowing Distance Marker Strips Downrange (+10m, +25m, +50m, +75m)
      [10, 25, 50, 75].forEach((mz) => {
        addBox(23, 0.03, 0.22, -3.5, 0.015, mz, accentAmberMat, false);
      });

      // Populate Calibrated Reactive Steel Targets (+Z downrange)
      createReactiveTarget('t_10m_L1', -8.2, 0, 10, 10, 1, false);
      createReactiveTarget('t_20m_L1', -9.4, 0, 20, 20, 1, false);
      createReactiveTarget('t_15m_move', -3.2, 0, 15, 15, 2, true, 2.2, 1.65);
      createReactiveTarget('t_25m_L2', -3.2, 0, 25, 25, 2, false);
      createReactiveTarget('t_28m_move', 1.6, 0, 28, 28, 3, true, 2.8, 1.35);
      createReactiveTarget('t_50m_L3', 1.6, 0, 50, 50, 3, false);
      createReactiveTarget('t_40m_L4', 6.0, 0, 40, 40, 4, false);
      createReactiveTarget('t_75m_L4', 6.0, 0, 75, 75, 4, false);

      // 30s Reflex Drill Pop-Up Targets
      [
        [-9.8, 8],
        [-5.8, 12],
        [-1.0, 11],
        [4.0, 13],
        [-7.2, 18],
        [-2.2, 22],
        [3.4, 20],
        [6.4, 26],
      ].forEach(([dx, dz], idx) => {
        createReactiveTarget(
          `drill_${idx}`,
          dx,
          0,
          dz,
          dz,
          0,
          idx % 3 === 0,
          1.4,
          2.0,
          true
        );
      });

      // ==================== CONNECTED CQB BREACHING KILLHOUSE WING (x: 10..36, z: 4..65) ====================
      addBox(8, 3.4, 0.35, 14, 1.7, 5, plywoodMat);
      addBox(8, 3.4, 0.35, 28, 1.7, 5, plywoodMat);
      addBox(0.35, 3.4, 14, 21, 1.7, 14, plywoodMat);
      addBox(9, 3.4, 0.35, 15, 1.7, 18, plywoodMat);
      addBox(9, 3.4, 0.35, 31, 1.7, 18, plywoodMat);

      addBox(1.8, 1.3, 1.8, 15, 0.65, 10, boothMat);
      addBox(2.2, 1.4, 1.4, 28, 0.7, 12, plywoodMat);
      addBox(1.8, 1.3, 1.8, 18, 0.65, 26, boothMat);
      addBox(2.4, 2.8, 2.4, 27, 1.4, 28, plywoodMat);
      addBox(9, 3.4, 0.35, 16, 1.7, 35, plywoodMat);
      addBox(9, 3.4, 0.35, 30, 1.7, 35, plywoodMat);

      // Studio Lighting & HDR Ceiling Fixtures
      const hemi = new HemisphericLight('hemi', new Vector3(0, 1, 0), scene);
      hemi.intensity = 0.65;
      hemi.groundColor = new Color3(0.18, 0.2, 0.24);
      hemi.parent = sceneGroup;

      addCeilingLightFixture(-4, 5.9, -2, new Color3(1.0, 0.92, 0.8), 1.4);
      addCeilingLightFixture(4, 5.9, -2, new Color3(1.0, 0.92, 0.8), 1.4);
      addCeilingLightFixture(-2, 7.5, 16, new Color3(0.85, 0.94, 1.0), 1.5);
      addCeilingLightFixture(-2, 7.5, 38, new Color3(0.85, 0.94, 1.0), 1.4);
      addCeilingLightFixture(22, 5.9, 12, new Color3(1.0, 0.86, 0.68), 1.5);
      addCeilingLightFixture(22, 5.9, 30, new Color3(1.0, 0.86, 0.68), 1.5);

      botWaypoints.push(
        new Vector3(15, 0, 9),
        new Vector3(29, 0, 9),
        new Vector3(16, 0, 22),
        new Vector3(29, 0, 23),
        new Vector3(23, 0, 31),
        new Vector3(15, 0, 40),
        new Vector3(30, 0, 42),
        new Vector3(22, 0, 15)
      );

      bombSites.push(
        { name: 'KILLHOUSE ROOM A', position: new Vector3(16, 0, 14) },
        { name: 'KILLHOUSE BREACH B', position: new Vector3(28, 0, 30) }
      );

      return {
        sceneGroup,
        reactiveTargets,
        playerSpawn: new Vector3(-2.5, 0, -3.2),
        playerSpawnYaw: 0, // Facing +Z North toward range targets!
        botWaypoints,
        bombSites,
        surfaceType: 'CONCRETE',
        defaultExposure: 1.16,
      };
    }

    if (mapId === 'CQB_POWERGUN') {
      // ==================== MAP 2: CQB POWERGUN WAREHOUSE ====================
      scene.clearColor = new Color4(0.03, 0.04, 0.055, 1.0);
      scene.fogMode = Scene.FOGMODE_EXP2;
      scene.fogColor = new Color3(0.03, 0.04, 0.055);
      scene.fogDensity = 0.02;

      const floorMat = new PBRMaterial('cqbFloor', scene);
      floorMat.albedoTexture = this.getConcreteTex(scene, 16, 16);
      floorMat.metallic = 0.3;
      floorMat.roughness = 0.45;

      const wallMat = new PBRMaterial('cqbWall', scene);
      wallMat.albedoTexture = this.getConcreteTex(scene, 12, 4);
      wallMat.albedoColor = new Color3(0.45, 0.49, 0.54);
      wallMat.metallic = 0.15;
      wallMat.roughness = 0.72;

      const blueContainerMat = new PBRMaterial('blueCont', scene);
      blueContainerMat.albedoTexture = this.getContainerTex(scene, '#1e3a5f');
      blueContainerMat.metallic = 0.65;
      blueContainerMat.roughness = 0.42;

      const redContainerMat = new PBRMaterial('redCont', scene);
      redContainerMat.albedoTexture = this.getContainerTex(scene, '#6b2121');
      redContainerMat.metallic = 0.65;
      redContainerMat.roughness = 0.42;

      const plywoodMat = new PBRMaterial('cqbPlywood', scene);
      plywoodMat.albedoTexture = this.getPlywoodTex(scene, 2, 2);
      plywoodMat.metallic = 0.05;
      plywoodMat.roughness = 0.68;

      const floor = MeshBuilder.CreateGround('cqbGround', { width: 56, height: 56 }, scene);
      floor.material = floorMat;
      floor.parent = sceneGroup;
      floor.checkCollisions = true;
      floor.isPickable = true;
      floor.metadata = { isWorldGeometry: true };

      addBox(56, 0.5, 56, 0, 8.5, 0, wallMat, false);
      addBox(56, 8.5, 0.6, 0, 4.25, -28, wallMat);
      addBox(56, 8.5, 0.6, 0, 4.25, 28, wallMat);
      addBox(0.6, 8.5, 56, -28, 4.25, 0, wallMat);
      addBox(0.6, 8.5, 56, 28, 4.25, 0, wallMat);

      addBox(3.2, 3.0, 8.5, -12, 1.5, 10, blueContainerMat);
      addBox(3.2, 3.0, 8.5, 12, 1.5, -10, redContainerMat);
      addBox(8.5, 3.0, 3.2, -10, 1.5, -12, redContainerMat);
      addBox(8.5, 3.0, 3.2, 11, 1.5, 13, blueContainerMat);

      addBox(8, 3.4, 0.35, -3.5, 1.7, 4.5, plywoodMat);
      addBox(8, 3.4, 0.35, 3.5, 1.7, -4.5, plywoodMat);
      addBox(0.35, 3.4, 7, -6.5, 1.7, -1, plywoodMat);
      addBox(0.35, 3.4, 7, 6.5, 1.7, 1, plywoodMat);

      [
        [-5, 12],
        [5, -12],
        [-15, 0],
        [15, 0],
        [0, 0],
      ].forEach(([cx, cz]) => {
        addBox(2.2, 1.25, 1.2, cx, 0.625, cz, plywoodMat);
      });

      createReactiveTarget('cqb_t1', -6, 0, 24, 24, 1, false);
      createReactiveTarget('cqb_t2', 6, 0, 24, 24, 2, true, 2.5, 1.5);

      const hemi = new HemisphericLight('cqbHemi', new Vector3(0, 1, 0), scene);
      hemi.intensity = 0.42;
      hemi.groundColor = new Color3(0.1, 0.12, 0.16);
      hemi.parent = sceneGroup;

      addCeilingLightFixture(0, 7.8, 0, new Color3(1.0, 0.84, 0.62), 1.8);
      addCeilingLightFixture(-14, 7.8, 14, new Color3(0.68, 0.85, 1.0), 1.3);
      addCeilingLightFixture(14, 7.8, -14, new Color3(1.0, 0.72, 0.48), 1.4);
      addCeilingLightFixture(-14, 7.8, -14, new Color3(0.8, 0.9, 1.0), 1.2);
      addCeilingLightFixture(14, 7.8, 14, new Color3(1.0, 0.84, 0.62), 1.3);

      botWaypoints.push(
        new Vector3(-16, 0, 8),
        new Vector3(16, 0, -8),
        new Vector3(0, 0, 9),
        new Vector3(0, 0, -9),
        new Vector3(-9, 0, -6),
        new Vector3(9, 0, 6),
        new Vector3(-18, 0, -14),
        new Vector3(18, 0, 14),
        new Vector3(0, 0, 20)
      );

      bombSites.push(
        { name: 'SITE A (KILLHOUSE CENTER)', position: new Vector3(0, 0, 0) },
        { name: 'SITE B (NORTH CONTAINER)', position: new Vector3(8, 0, 16) }
      );

      return {
        sceneGroup,
        reactiveTargets,
        playerSpawn: new Vector3(0, 0, -22),
        playerSpawnYaw: 0,
        botWaypoints,
        bombSites,
        surfaceType: 'CONCRETE',
        defaultExposure: 1.12,
      };
    }

    // ==================== MAP 3: TRENCHES (v0.8 LOCKED & LOADED OUTDOOR BATTLEFIELD) ====================
    scene.clearColor = new Color4(0.32, 0.36, 0.4, 1.0);
    scene.fogMode = Scene.FOGMODE_EXP2;
    scene.fogColor = new Color3(0.32, 0.36, 0.4);
    scene.fogDensity = 0.016;

    const mudMat = new PBRMaterial('mudMat', scene);
    mudMat.albedoTexture = this.getMudTex(scene, 20, 20);
    mudMat.metallic = 0.08;
    mudMat.roughness = 0.78;

    const woodMat = new PBRMaterial('trenchWood', scene);
    woodMat.albedoTexture = this.getPlywoodTex(scene, 3, 1);
    woodMat.albedoColor = new Color3(0.55, 0.42, 0.28);
    woodMat.metallic = 0.05;
    woodMat.roughness = 0.82;

    const stoneMat = new PBRMaterial('churchStone', scene);
    stoneMat.albedoTexture = this.getConcreteTex(scene, 8, 4);
    stoneMat.albedoColor = new Color3(0.58, 0.6, 0.64);
    stoneMat.metallic = 0.1;
    stoneMat.roughness = 0.85;

    const sandbagMat = new PBRMaterial('sandbagMat', scene);
    sandbagMat.albedoColor = new Color3(0.48, 0.44, 0.34);
    sandbagMat.metallic = 0.02;
    sandbagMat.roughness = 0.9;

    const floor = MeshBuilder.CreateGround('trenchGround', { width: 76, height: 76 }, scene);
    floor.material = mudMat;
    floor.parent = sceneGroup;
    floor.checkCollisions = true;
    floor.isPickable = true;
    floor.metadata = { isWorldGeometry: true };

    addBox(76, 4.5, 1.5, 0, 2.25, -38, mudMat);
    addBox(76, 4.5, 1.5, 0, 2.25, 38, mudMat);
    addBox(1.5, 4.5, 76, -38, 2.25, 0, mudMat);
    addBox(1.5, 4.5, 76, 38, 2.25, 0, mudMat);

    [
      [-14, -15, 12, 2.1, 1.6],
      [14, -15, 12, 2.1, 1.6],
      [-18, 0, 6, 2.3, 8],
      [18, 0, 6, 2.3, 8],
      [-14, 15, 12, 2.1, 1.6],
      [14, 15, 12, 2.1, 1.6],
    ].forEach(([bx, bz, bw, bh, bd]) => {
      addBox(bw, bh, bd, bx, bh * 0.5, bz, woodMat);
      addBox(bw * 0.9, 0.55, bd * 0.8, bx, bh + 0.25, bz, sandbagMat);
    });

    // Central Ruined Church Sanctuary & Bell Tower
    addBox(9, 4.2, 0.7, -4.5, 2.1, 5, stoneMat);
    addBox(9, 4.2, 0.7, 4.5, 2.1, -5, stoneMat);
    addBox(0.7, 4.2, 8, -8.5, 2.1, -1, stoneMat);
    addBox(0.7, 4.2, 8, 8.5, 2.1, 1, stoneMat);
    addBox(2.8, 9.5, 2.8, -7.5, 4.75, 4.5, stoneMat);

    createReactiveTarget('trench_t1', -8, 0, 29, 55, 1, false);
    createReactiveTarget('trench_t2', 8, 0, 29, 55, 2, true, 3.2, 1.3);

    const hemi = new HemisphericLight('trenchHemi', new Vector3(0, 1, 0), scene);
    hemi.intensity = 0.95;
    hemi.groundColor = new Color3(0.24, 0.2, 0.17);
    hemi.parent = sceneGroup;

    const sun = new DirectionalLight('trenchSun', new Vector3(0.4, -0.8, 0.4), scene);
    sun.intensity = 1.25;
    sun.parent = sceneGroup;

    botWaypoints.push(
      new Vector3(-12, 0, 22),
      new Vector3(12, 0, 22),
      new Vector3(0, 0, 10),
      new Vector3(-10, 0, 0),
      new Vector3(10, 0, 0),
      new Vector3(0, 0, 0),
      new Vector3(-14, 0, -10),
      new Vector3(14, 0, -10),
      new Vector3(0, 0, -20)
    );

    bombSites.push(
      { name: 'RUINED CHURCH ALTAR (A)', position: new Vector3(0, 0, 0) },
      { name: 'NORTH DRONE BUNKER (B)', position: new Vector3(-14, 0, 18) }
    );

    return {
      sceneGroup,
      reactiveTargets,
      playerSpawn: new Vector3(0, 0, -28),
      playerSpawnYaw: 0,
      botWaypoints,
      bombSites,
      surfaceType: 'MUD',
      defaultExposure: 1.12,
    };
  }
}
