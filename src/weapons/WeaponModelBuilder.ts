import {
  Color3,
  Mesh,
  MeshBuilder,
  PBRMaterial,
  PointLight,
  Scene,
  SpotLight,
  StandardMaterial,
  TransformNode,
  Vector3,
} from '@babylonjs/core';
import { AttachmentDef, WeaponDef } from '../data/bodycamData';

export interface BuiltWeaponRig {
  root: TransformNode;
  magazineGroup: TransformNode;
  brassBulletMesh: Mesh;
  boltGroup: TransformNode;
  pumpGroup: TransformNode;
  leftHandGroup: TransformNode;
  rightHandGroup: TransformNode;
  muzzlePoint: TransformNode;
  ejectionPoint: TransformNode;
  sightAlignLocal: Vector3;
  muzzleFlashMesh: Mesh;
  muzzleFlashLight: PointLight;
  flashlightSpot: SpotLight;
  laserBeamMesh: Mesh;
  laserDotMesh: Mesh;
  hasLaser: boolean;
  hasFlashlight: boolean;
}

function hexToColor3(hex: number): Color3 {
  const r = ((hex >> 16) & 255) / 255;
  const g = ((hex >> 8) & 255) / 255;
  const b = (hex & 255) / 255;
  return new Color3(r, g, b);
}

export class WeaponModelBuilder {
  public static buildWeapon(
    scene: Scene,
    weapon: WeaponDef,
    attachments: Record<string, AttachmentDef>
  ): BuiltWeaponRig {
    const root = new TransformNode(`weapon_${weapon.id}`, scene);
    const v = weapon.visual;

    // Studio-Grade PBR Materials
    const receiverMat = new PBRMaterial(`recMat_${weapon.id}`, scene);
    receiverMat.albedoColor = hexToColor3(v.receiverColor);
    receiverMat.metallic = 0.82;
    receiverMat.roughness = 0.34;

    const furnitureMat = new PBRMaterial(`furnMat_${weapon.id}`, scene);
    furnitureMat.albedoColor = hexToColor3(v.furnitureColor);
    const isWood = v.stockStyle === 'wood' || v.handguardStyle === 'wood';
    furnitureMat.metallic = isWood ? 0.08 : 0.22;
    furnitureMat.roughness = isWood ? 0.52 : 0.48;

    const darkSteelMat = new PBRMaterial(`steelMat_${weapon.id}`, scene);
    darkSteelMat.albedoColor = hexToColor3(v.metalColor);
    darkSteelMat.metallic = 0.9;
    darkSteelMat.roughness = 0.28;

    const chromeBoltMat = new PBRMaterial(`chromeMat_${weapon.id}`, scene);
    chromeBoltMat.albedoColor = new Color3(0.76, 0.79, 0.83);
    chromeBoltMat.metallic = 0.95;
    chromeBoltMat.roughness = 0.18;

    const isPistol = !!v.isPistol;
    const recW = isPistol ? 0.032 : 0.046;
    const recH = v.receiverHeight;
    const recL = v.receiverLength;

    // 1. Upper & Lower Receiver (In Babylon.js, +Z is forward toward muzzle!)
    const receiverMesh = MeshBuilder.CreateBox(
      'receiver',
      { width: recW, height: recH, depth: recL },
      scene
    );
    receiverMesh.material = receiverMat;
    receiverMesh.parent = root;
    receiverMesh.isPickable = false;

    // beveled upper receiver detail & Picatinny Rail Teeth
    if (!isPistol) {
      const railBase = MeshBuilder.CreateBox(
        'railBase',
        { width: recW * 0.72, height: 0.008, depth: recL * 0.95 },
        scene
      );
      railBase.position.set(0, recH * 0.5 + 0.004, 0.01);
      railBase.material = darkSteelMat;
      railBase.parent = root;
      railBase.isPickable = false;

      // Individual Picatinny Rail Lugs
      const numLugs = 12;
      for (let i = 0; i < numLugs; i++) {
        const lug = MeshBuilder.CreateBox(
          `lug_${i}`,
          { width: recW * 0.76, height: 0.005, depth: 0.01 },
          scene
        );
        lug.position.set(
          0,
          recH * 0.5 + 0.009,
          -recL * 0.42 + (i / (numLugs - 1)) * (recL * 0.86)
        );
        lug.material = darkSteelMat;
        lug.parent = root;
        lug.isPickable = false;
      }
    }

    // 2. Ergonomic Pistol Grip & Trigger Guard
    const gripMesh = MeshBuilder.CreateBox(
      'grip',
      { width: recW * 0.76, height: 0.105, depth: 0.044 },
      scene
    );
    gripMesh.position.set(0, -recH * 0.5 - 0.042, isPistol ? -0.035 : -recL * 0.26);
    gripMesh.rotation.x = 0.28;
    gripMesh.material = furnitureMat;
    gripMesh.parent = root;
    gripMesh.isPickable = false;

    const guardMesh = MeshBuilder.CreateBox(
      'triggerGuard',
      { width: recW * 0.42, height: 0.026, depth: 0.056 },
      scene
    );
    guardMesh.position.set(0, -recH * 0.5 - 0.014, isPistol ? 0.005 : -recL * 0.12);
    guardMesh.material = darkSteelMat;
    guardMesh.parent = root;
    guardMesh.isPickable = false;

    // 3. Barrel, Gas Block & Ventilated Handguard (+Z forward)
    const barrelStartZ = recL * 0.5;
    const barrelLen = v.barrelLength;
    const barrelRadius = isPistol ? 0.008 : weapon.category === 'Shotguns' ? 0.013 : 0.01;
    const barrelMesh = MeshBuilder.CreateCylinder(
      'barrel',
      { diameter: barrelRadius * 2, height: barrelLen, tessellation: 14 },
      scene
    );
    barrelMesh.rotation.x = Math.PI / 2;
    barrelMesh.position.set(
      0,
      isPistol ? recH * 0.1 : recH * 0.12,
      barrelStartZ + barrelLen * 0.5 - 0.04
    );
    barrelMesh.material = darkSteelMat;
    barrelMesh.parent = root;
    barrelMesh.isPickable = false;

    const pumpGroup = new TransformNode('pumpGroup', scene);
    pumpGroup.parent = root;

    if (!isPistol) {
      const hgLen = Math.min(barrelLen * 0.72, 0.32);
      const hgW = recW * 1.05;
      const hgH = recH * 0.88;

      if (v.handguardStyle === 'shotgun_pump') {
        const tube = MeshBuilder.CreateCylinder(
          'magTube',
          { diameter: 0.022, height: barrelLen * 0.92, tessellation: 12 },
          scene
        );
        tube.rotation.x = Math.PI / 2;
        tube.position.set(0, -0.012, barrelStartZ + barrelLen * 0.44);
        tube.material = darkSteelMat;
        tube.parent = root;
        tube.isPickable = false;

        const pumpForend = MeshBuilder.CreateCylinder(
          'pumpForend',
          { diameter: 0.044, height: 0.165, tessellation: 14 },
          scene
        );
        pumpForend.rotation.x = Math.PI / 2;
        pumpForend.position.set(0, -0.014, barrelStartZ + 0.15);
        pumpForend.material = furnitureMat;
        pumpForend.parent = pumpGroup;
        pumpForend.isPickable = false;
      } else {
        const hgMesh = MeshBuilder.CreateBox(
          'handguard',
          { width: hgW, height: hgH, depth: hgLen },
          scene
        );
        hgMesh.position.set(0, 0.004, barrelStartZ + hgLen * 0.5 - 0.02);
        hgMesh.material = v.handguardStyle === 'quadrail' ? darkSteelMat : furnitureMat;
        hgMesh.parent = root;
        hgMesh.isPickable = false;
      }
    }

    // 4. Buttstock Assembly (-Z rearward)
    if (!isPistol && v.stockStyle !== 'none') {
      const stockZ = -recL * 0.5 - 0.11;
      if (v.stockStyle === 'wire' || v.stockStyle === 'folded') {
        const rod = MeshBuilder.CreateCylinder(
          'stockRod',
          { diameter: 0.014, height: 0.22, tessellation: 10 },
          scene
        );
        rod.rotation.x = Math.PI / 2;
        rod.position.set(0, 0.01, stockZ);
        rod.material = darkSteelMat;
        rod.parent = root;
        rod.isPickable = false;

        const butt = MeshBuilder.CreateBox(
          'buttplate',
          { width: 0.038, height: 0.096, depth: 0.022 },
          scene
        );
        butt.position.set(0, -0.01, stockZ - 0.11);
        butt.material = darkSteelMat;
        butt.parent = root;
        butt.isPickable = false;
      } else {
        const stockMesh = MeshBuilder.CreateBox(
          'stock',
          { width: recW * 0.88, height: recH * 1.14, depth: 0.23 },
          scene
        );
        stockMesh.position.set(0, -0.012, stockZ);
        stockMesh.material = furnitureMat;
        stockMesh.parent = root;
        stockMesh.isPickable = false;
      }
    }

    // 5. Articulated Bolt Carrier / Slide Group (kicks backward along -Z on fire!)
    const boltGroup = new TransformNode('boltGroup', scene);
    boltGroup.parent = root;

    if (isPistol) {
      if (v.isRevolver) {
        const cylMesh = MeshBuilder.CreateCylinder(
          'revolverCylinder',
          { diameter: 0.044, height: 0.048, tessellation: 10 },
          scene
        );
        cylMesh.rotation.x = Math.PI / 2;
        cylMesh.position.set(0, 0.005, 0.01);
        cylMesh.material = chromeBoltMat;
        cylMesh.parent = boltGroup;
        cylMesh.isPickable = false;
      } else {
        const slideMesh = MeshBuilder.CreateBox(
          'pistolSlide',
          { width: recW * 1.06, height: recH * 0.74, depth: recL * 1.02 },
          scene
        );
        slideMesh.position.set(0, recH * 0.26, 0.005);
        slideMesh.material = receiverMat;
        slideMesh.parent = boltGroup;
        slideMesh.isPickable = false;
      }
    } else {
      const portMesh = MeshBuilder.CreateBox(
        'boltCarrier',
        { width: 0.008, height: 0.019, depth: 0.07 },
        scene
      );
      portMesh.position.set(recW * 0.5 + 0.002, 0.012, 0.02);
      portMesh.material = chromeBoltMat;
      portMesh.parent = boltGroup;
      portMesh.isPickable = false;

      const handleMesh = MeshBuilder.CreateBox(
        'chargingHandle',
        { width: 0.03, height: 0.01, depth: 0.014 },
        scene
      );
      handleMesh.position.set(recW * 0.5 + 0.015, 0.014, 0.04);
      handleMesh.material = darkSteelMat;
      handleMesh.parent = boltGroup;
      handleMesh.isPickable = false;
    }

    // 6. Detachable Magazine Group + Visible Brass Cartridge for [M] Mag Check
    const magazineGroup = new TransformNode('magazineGroup', scene);
    const magZ = isPistol ? -0.035 : 0.048;
    const magY = -recH * 0.5;
    magazineGroup.position.set(0, magY, magZ);
    magazineGroup.parent = root;

    const magMod = attachments.magazine?.modifiers;
    const extraLen = magMod?.magCapDelta ? 0.045 : 0;
    const magLen = v.magLength + extraLen;

    if (v.magLength > 0.04) {
      const magMesh = MeshBuilder.CreateBox(
        'magazineBody',
        { width: recW * 0.68, height: magLen, depth: 0.056 },
        scene
      );
      magMesh.position.set(0, -magLen * 0.48, v.magCurvature * 0.025);
      magMesh.rotation.x = -v.magCurvature * 0.28;
      magMesh.material = weapon.id.startsWith('ka') ? furnitureMat : darkSteelMat;
      magMesh.parent = magazineGroup;
      magMesh.isPickable = false;
    }

    const brassMat = new PBRMaterial(`brassMat_${weapon.id}`, scene);
    brassMat.albedoColor = new Color3(0.88, 0.72, 0.24);
    brassMat.metallic = 0.92;
    brassMat.roughness = 0.2;

    const brassBulletMesh = MeshBuilder.CreateCylinder(
      'topBrassCartridge',
      { diameter: 0.011, height: 0.038, tessellation: 10 },
      scene
    );
    brassBulletMesh.rotation.x = Math.PI / 2;
    brassBulletMesh.position.set(0, 0.005, 0);
    brassBulletMesh.material = brassMat;
    brassBulletMesh.parent = magazineGroup;
    brassBulletMesh.isPickable = false;

    // 7. ATTACHMENTS: OPTICS & TRUE HDR EMISSIVE RETICLES
    const opticMod = attachments.optic?.modifiers;
    const opticType = opticMod?.opticType || 'iron';
    const topY = isPistol ? recH * 0.62 : recH * 0.5 + 0.012;
    let sightAlignY = topY + 0.022;

    // HDR Glowing Emissive Material for Reticles
    const greenTritiumMat = new StandardMaterial('tritiumMat', scene);
    greenTritiumMat.disableLighting = true;
    greenTritiumMat.emissiveColor = new Color3(0.2, 2.2, 0.55); // >1.0 triggers Babylon HDR Bloom!

    const redReticleMat = new StandardMaterial('redReticleMat', scene);
    redReticleMat.disableLighting = true;
    redReticleMat.emissiveColor = new Color3(2.8, 0.22, 0.18);

    if (opticType === 'iron') {
      const frontZ = isPistol ? recL * 0.46 : barrelStartZ + barrelLen * 0.65;
      const frontPost = MeshBuilder.CreateBox(
        'frontPost',
        { width: 0.004, height: 0.022, depth: 0.006 },
        scene
      );
      frontPost.position.set(0, topY + 0.011, frontZ);
      frontPost.material = darkSteelMat;
      frontPost.parent = root;
      frontPost.isPickable = false;

      const tritiumDot = MeshBuilder.CreateSphere(
        'tritiumFront',
        { diameter: 0.0044, segments: 8 },
        scene
      );
      tritiumDot.position.set(0, topY + 0.021, frontZ - 0.003);
      tritiumDot.material = greenTritiumMat;
      tritiumDot.parent = root;
      tritiumDot.isPickable = false;

      const rearZ = isPistol ? -recL * 0.42 : -recL * 0.35;
      [-0.009, 0.009].forEach((rx, idx) => {
        const ear = MeshBuilder.CreateBox(
          `rearEar_${idx}`,
          { width: 0.006, height: 0.02, depth: 0.008 },
          scene
        );
        ear.position.set(rx, topY + 0.01, rearZ);
        ear.material = darkSteelMat;
        ear.parent = root;
        ear.isPickable = false;
      });

      sightAlignY = topY + 0.021;
    } else if (opticType === 'reddot' || opticType === 'holo') {
      const mountZ = isPistol ? -0.01 : -0.015;
      const housingW = opticType === 'holo' ? 0.044 : 0.035;
      const housingH = opticType === 'holo' ? 0.045 : 0.036;

      const baseMesh = MeshBuilder.CreateBox(
        'opticBase',
        { width: housingW, height: 0.012, depth: 0.056 },
        scene
      );
      baseMesh.position.set(0, topY + 0.006, mountZ);
      baseMesh.material = darkSteelMat;
      baseMesh.parent = root;
      baseMesh.isPickable = false;

      const wallL = MeshBuilder.CreateBox(
        'opticWallL',
        { width: 0.004, height: housingH, depth: 0.048 },
        scene
      );
      wallL.position.set(-housingW * 0.46, topY + 0.012 + housingH * 0.5, mountZ);
      wallL.material = darkSteelMat;
      wallL.parent = root;
      wallL.isPickable = false;

      const wallR = MeshBuilder.CreateBox(
        'opticWallR',
        { width: 0.004, height: housingH, depth: 0.048 },
        scene
      );
      wallR.position.set(housingW * 0.46, topY + 0.012 + housingH * 0.5, mountZ);
      wallR.material = darkSteelMat;
      wallR.parent = root;
      wallR.isPickable = false;

      const roof = MeshBuilder.CreateBox(
        'opticRoof',
        { width: housingW, height: 0.004, depth: 0.048 },
        scene
      );
      roof.position.set(0, topY + 0.012 + housingH, mountZ);
      roof.material = darkSteelMat;
      roof.parent = root;
      roof.isPickable = false;

      // Illuminated Holographic / Reflex Reticle inside optic window
      const reticleCenterY = topY + 0.012 + housingH * 0.5;
      const dotMesh = MeshBuilder.CreateDisc(
        'reticleDot',
        { radius: 0.0018, tessellation: 14, sideOrientation: Mesh.DOUBLESIDE },
        scene
      );
      dotMesh.position.set(0, reticleCenterY, mountZ);
      dotMesh.material = redReticleMat;
      dotMesh.parent = root;
      dotMesh.isPickable = false;

      if (opticType === 'holo') {
        const ringMesh = MeshBuilder.CreateTorus(
          'holoRing',
          { diameter: 0.015, thickness: 0.0012, tessellation: 24 },
          scene
        );
        ringMesh.rotation.x = Math.PI / 2;
        ringMesh.position.set(0, reticleCenterY, mountZ);
        ringMesh.material = redReticleMat;
        ringMesh.parent = root;
        ringMesh.isPickable = false;
      }

      sightAlignY = reticleCenterY;
    } else if (opticType === 'acog' || opticType === 'sniper8x') {
      const scopeLen = opticType === 'sniper8x' ? 0.24 : 0.14;
      const scopeR = opticType === 'sniper8x' ? 0.022 : 0.019;
      const centerY = topY + 0.032;

      [-scopeLen * 0.45, scopeLen * 0.45].forEach((sz, idx) => {
        const ring = MeshBuilder.CreateTorus(
          `scopeRing_${idx}`,
          { diameter: scopeR * 2, thickness: 0.007, tessellation: 20 },
          scene
        );
        ring.rotation.x = Math.PI / 2;
        ring.position.set(0, centerY, sz);
        ring.material = darkSteelMat;
        ring.parent = root;
        ring.isPickable = false;
      });

      const hWire = MeshBuilder.CreateBox(
        'scopeWireH',
        { width: scopeR * 1.7, height: 0.0008, depth: 0.001 },
        scene
      );
      hWire.position.set(0, centerY, 0);
      hWire.material = opticType === 'acog' ? redReticleMat : greenTritiumMat;
      hWire.parent = root;
      hWire.isPickable = false;

      const vWire = MeshBuilder.CreateBox(
        'scopeWireV',
        { width: 0.0008, height: scopeR * 1.7, depth: 0.001 },
        scene
      );
      vWire.position.set(0, centerY, 0);
      vWire.material = opticType === 'acog' ? redReticleMat : greenTritiumMat;
      vWire.parent = root;
      vWire.isPickable = false;

      sightAlignY = centerY;
    }

    // 8. ATTACHMENTS: MUZZLE & SUPPRESSOR (+Z forward tip)
    const muzzleMod = attachments.muzzle?.modifiers;
    const barrelTipZ = barrelStartZ + barrelLen - 0.04;
    let finalMuzzleZ = barrelTipZ;

    if (muzzleMod?.suppressed) {
      const supLen = isPistol ? 0.14 : 0.19;
      const supMesh = MeshBuilder.CreateCylinder(
        'suppressor',
        { diameter: 0.038, height: supLen, tessellation: 16 },
        scene
      );
      supMesh.rotation.x = Math.PI / 2;
      supMesh.position.set(0, barrelMesh.position.y, barrelTipZ + supLen * 0.5);
      supMesh.material = darkSteelMat;
      supMesh.parent = root;
      supMesh.isPickable = false;
      finalMuzzleZ = barrelTipZ + supLen;
    } else {
      const brakeLen = 0.045;
      const brakeMesh = MeshBuilder.CreateCylinder(
        'muzzleBrake',
        { diameter: barrelRadius * 2.6, height: brakeLen, tessellation: 12 },
        scene
      );
      brakeMesh.rotation.x = Math.PI / 2;
      brakeMesh.position.set(0, barrelMesh.position.y, barrelTipZ + brakeLen * 0.5);
      brakeMesh.material = darkSteelMat;
      brakeMesh.parent = root;
      brakeMesh.isPickable = false;
      finalMuzzleZ = barrelTipZ + brakeLen;
    }

    // 9. ATTACHMENTS: UNDERBARREL FOREGRIP
    const gripId = attachments.grip?.id;
    if (!isPistol && gripId === 'grip_vert') {
      const vgMesh = MeshBuilder.CreateCylinder(
        'vertGrip',
        { diameter: 0.029, height: 0.095, tessellation: 12 },
        scene
      );
      vgMesh.position.set(0, -recH * 0.5 - 0.045, barrelStartZ + 0.14);
      vgMesh.material = furnitureMat;
      vgMesh.parent = root;
      vgMesh.isPickable = false;
    } else if (!isPistol && gripId === 'grip_angled') {
      const agMesh = MeshBuilder.CreateBox(
        'angledGrip',
        { width: 0.028, height: 0.032, depth: 0.095 },
        scene
      );
      agMesh.position.set(0, -recH * 0.5 - 0.012, barrelStartZ + 0.14);
      agMesh.rotation.x = -0.25;
      agMesh.material = furnitureMat;
      agMesh.parent = root;
      agMesh.isPickable = false;
    }

    // 10. MUZZLE POINT, HDR BLOOM FLASH & BRASS EJECTION PORT
    const muzzlePoint = new TransformNode('muzzlePoint', scene);
    muzzlePoint.position.set(0, barrelMesh.position.y, finalMuzzleZ + 0.015);
    muzzlePoint.parent = root;

    const ejectionPoint = new TransformNode('ejectionPoint', scene);
    ejectionPoint.position.set(recW * 0.6, 0.015, 0.02);
    ejectionPoint.parent = root;

    const flashMat = new StandardMaterial('muzzleFlashMat', scene);
    flashMat.disableLighting = true;
    flashMat.emissiveColor = new Color3(3.5, 2.1, 0.6); // Strong HDR Bloom!
    flashMat.alpha = 0;

    const muzzleFlashMesh = MeshBuilder.CreatePolyhedron(
      'muzzleFlash',
      { type: 2, size: 0.068 },
      scene
    );
    muzzleFlashMesh.material = flashMat;
    muzzleFlashMesh.parent = muzzlePoint;
    muzzleFlashMesh.isPickable = false;

    const muzzleFlashLight = new PointLight('muzzleFlashLight', Vector3.Zero(), scene);
    muzzleFlashLight.parent = muzzlePoint;
    muzzleFlashLight.diffuse = new Color3(1.0, 0.72, 0.32);
    muzzleFlashLight.intensity = 0;
    muzzleFlashLight.range = 11;

    // 11. TACTICAL RAIL MODULE (Real SpotLight Flashlight + HDR Laser Beam & World Hit Dot)
    const tacMod = attachments.tactical?.modifiers;
    const hasFlashlight = tacMod?.hasFlashlight !== false;
    const hasLaser = tacMod?.hasLaser !== false;
    const laserHex = tacMod?.laserColor || 0x22ff66;

    const peqZ = isPistol ? barrelStartZ + 0.04 : barrelStartZ + 0.18;
    const peqX = isPistol ? 0 : recW * 0.58;
    const peqY = isPistol ? -recH * 0.45 : 0.005;

    const peqBox = MeshBuilder.CreateBox(
      'peqBox',
      { width: 0.024, height: 0.022, depth: 0.068 },
      scene
    );
    peqBox.position.set(peqX, peqY, peqZ);
    peqBox.material = darkSteelMat;
    peqBox.parent = root;
    peqBox.isPickable = false;

    const flashlightSpot = new SpotLight(
      'weaponFlashlight',
      new Vector3(peqX, peqY, peqZ + 0.036),
      new Vector3(0, 0, 1),
      Math.PI / 3.4,
      6,
      scene
    );
    flashlightSpot.parent = root;
    flashlightSpot.diffuse = new Color3(1.0, 0.97, 0.9);
    flashlightSpot.intensity = 0;
    flashlightSpot.range = 48;

    const laserCol = hexToColor3(laserHex);
    const laserMat = new StandardMaterial('laserBeamMat', scene);
    laserMat.disableLighting = true;
    laserMat.emissiveColor = laserCol.scale(2.4); // Blooms in HDR!
    laserMat.alpha = hasLaser ? 0.55 : 0;

    // Cylinder of height 1 rotated along +Z and shifted by +0.5 Z so scaling.z extends forward from PEQ tip
    const laserBeamMesh = MeshBuilder.CreateCylinder(
      'laserBeam',
      { diameter: 0.0018, height: 1.0, tessellation: 8 },
      scene
    );
    laserBeamMesh.rotation.x = Math.PI / 2;
    laserBeamMesh.position.set(0, 0, 0.5);
    laserBeamMesh.bakeCurrentTransformIntoVertices();
    laserBeamMesh.position.set(peqX, peqY, peqZ + 0.035);
    laserBeamMesh.material = laserMat;
    laserBeamMesh.parent = root;
    laserBeamMesh.isPickable = false;

    const dotMat = new StandardMaterial('laserDotMat', scene);
    dotMat.disableLighting = true;
    dotMat.emissiveColor = laserCol.scale(3.5);

    const laserDotMesh = MeshBuilder.CreateSphere(
      'laserHitDot',
      { diameter: 0.032, segments: 8 },
      scene
    );
    laserDotMesh.material = dotMat;
    laserDotMesh.isPickable = false;
    laserDotMesh.isVisible = hasLaser;

    // 12. "TRUE BODY" OPERATOR TACTICAL GLOVES & SLEEVES
    const gloveMat = new PBRMaterial('gloveMat', scene);
    gloveMat.albedoColor = new Color3(0.16, 0.15, 0.13);
    gloveMat.roughness = 0.78;
    gloveMat.metallic = 0.08;

    const sleeveMat = new PBRMaterial('sleeveMat', scene);
    sleeveMat.albedoColor = new Color3(0.22, 0.26, 0.2);
    sleeveMat.roughness = 0.85;
    sleeveMat.metallic = 0.05;

    const rightHandGroup = new TransformNode('rightHandGroup', scene);
    rightHandGroup.parent = root;
    const rGlove = MeshBuilder.CreateBox(
      'rGlove',
      { width: 0.052, height: 0.068, depth: 0.075 },
      scene
    );
    rGlove.position.set(0.01, -recH * 0.5 - 0.038, gripMesh.position.z - 0.01);
    rGlove.material = gloveMat;
    rGlove.parent = rightHandGroup;
    rGlove.isPickable = false;

    const rArm = MeshBuilder.CreateBox(
      'rArm',
      { width: 0.065, height: 0.065, depth: 0.28 },
      scene
    );
    rArm.position.set(0.055, -recH * 0.5 - 0.085, gripMesh.position.z - 0.16);
    rArm.rotation.y = 0.22;
    rArm.rotation.x = -0.25;
    rArm.material = sleeveMat;
    rArm.parent = rightHandGroup;
    rArm.isPickable = false;

    const leftHandGroup = new TransformNode('leftHandGroup', scene);
    leftHandGroup.parent = root;
    const lHandZ = isPistol ? gripMesh.position.z + 0.01 : barrelStartZ + 0.14;
    const lGlove = MeshBuilder.CreateBox(
      'lGlove',
      { width: 0.052, height: 0.062, depth: 0.082 },
      scene
    );
    lGlove.position.set(-0.018, -recH * 0.5 - 0.025, lHandZ);
    lGlove.material = gloveMat;
    lGlove.parent = leftHandGroup;
    lGlove.isPickable = false;

    const lArm = MeshBuilder.CreateBox(
      'lArm',
      { width: 0.064, height: 0.064, depth: 0.34 },
      scene
    );
    lArm.position.set(-0.095, -recH * 0.5 - 0.095, lHandZ - 0.17);
    lArm.rotation.y = -0.38;
    lArm.rotation.x = -0.28;
    lArm.material = sleeveMat;
    lArm.parent = leftHandGroup;
    lArm.isPickable = false;

    return {
      root,
      magazineGroup,
      brassBulletMesh,
      boltGroup,
      pumpGroup,
      leftHandGroup,
      rightHandGroup,
      muzzlePoint,
      ejectionPoint,
      sightAlignLocal: new Vector3(0, sightAlignY, 0),
      muzzleFlashMesh,
      muzzleFlashLight,
      flashlightSpot,
      laserBeamMesh,
      laserDotMesh,
      hasLaser,
      hasFlashlight,
    };
  }
}
