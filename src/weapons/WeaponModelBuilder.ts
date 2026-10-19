import * as THREE from 'three';
import { AttachmentDef, WeaponDef } from '../data/bodycamData';

export interface BuiltWeaponRig {
  root: THREE.Group;
  magazineGroup: THREE.Group;
  brassBulletMesh: THREE.Mesh; // Visible top cartridge during [M] Mag Check!
  boltGroup: THREE.Group;
  pumpGroup: THREE.Group;
  leftHandGroup: THREE.Group;
  rightHandGroup: THREE.Group;
  muzzlePoint: THREE.Object3D;
  ejectionPoint: THREE.Object3D;
  sightAlignLocal: THREE.Vector3; // Local offset to align camera eye with optic center
  muzzleFlashMesh: THREE.Mesh;
  muzzleFlashLight: THREE.PointLight;
  flashlightSpot: THREE.SpotLight;
  flashlightTarget: THREE.Object3D;
  laserBeamMesh: THREE.Mesh;
  laserDotMesh: THREE.Mesh;
  hasLaser: boolean;
  hasFlashlight: boolean;
}

export class WeaponModelBuilder {
  public static buildWeapon(
    weapon: WeaponDef,
    attachments: Record<string, AttachmentDef>
  ): BuiltWeaponRig {
    const root = new THREE.Group();
    const v = weapon.visual;

    const receiverMat = new THREE.MeshStandardMaterial({
      color: v.receiverColor,
      roughness: 0.42,
      metalness: 0.68,
    });
    const furnitureMat = new THREE.MeshStandardMaterial({
      color: v.furnitureColor,
      roughness: v.stockStyle === 'wood' || v.handguardStyle === 'wood' ? 0.65 : 0.55,
      metalness: v.stockStyle === 'wood' || v.handguardStyle === 'wood' ? 0.1 : 0.25,
    });
    const darkMetalMat = new THREE.MeshStandardMaterial({
      color: v.metalColor,
      roughness: 0.35,
      metalness: 0.85,
    });
    const chromeBoltMat = new THREE.MeshStandardMaterial({
      color: 0xaab2ba,
      roughness: 0.25,
      metalness: 0.92,
    });

    const isPistol = !!v.isPistol;
    const recW = isPistol ? 0.032 : 0.046;
    const recH = v.receiverHeight;
    const recL = v.receiverLength;

    // 1. Upper & Lower Receiver
    const receiverGeo = new THREE.BoxGeometry(recW, recH, recL);
    const receiverMesh = new THREE.Mesh(receiverGeo, receiverMat);
    receiverMesh.position.set(0, 0, 0);
    receiverMesh.castShadow = true;
    root.add(receiverMesh);

    // Top Picatinny Rail (for rifles/SMGs/shotguns)
    if (!isPistol) {
      const railGeo = new THREE.BoxGeometry(recW * 0.72, 0.01, recL * 0.92);
      const railMesh = new THREE.Mesh(railGeo, darkMetalMat);
      railMesh.position.set(0, recH * 0.5 + 0.005, -0.01);
      root.add(railMesh);
    }

    // 2. Pistol Grip & Trigger Guard
    const gripGeo = new THREE.BoxGeometry(recW * 0.78, 0.105, 0.044);
    const gripMesh = new THREE.Mesh(gripGeo, furnitureMat);
    gripMesh.position.set(0, -recH * 0.5 - 0.042, isPistol ? 0.035 : recL * 0.26);
    gripMesh.rotation.x = -0.26;
    root.add(gripMesh);

    const guardGeo = new THREE.BoxGeometry(recW * 0.4, 0.026, 0.055);
    const guardMesh = new THREE.Mesh(guardGeo, darkMetalMat);
    guardMesh.position.set(0, -recH * 0.5 - 0.014, isPistol ? -0.005 : recL * 0.12);
    root.add(guardMesh);

    // 3. Barrel & Handguard
    const barrelStartZ = -recL * 0.5;
    const barrelLen = v.barrelLength;
    const barrelRadius = isPistol ? 0.008 : weapon.category === 'Shotguns' ? 0.013 : 0.01;
    const barrelGeo = new THREE.CylinderGeometry(barrelRadius, barrelRadius * 1.1, barrelLen, 12);
    barrelGeo.rotateX(Math.PI / 2);
    const barrelMesh = new THREE.Mesh(barrelGeo, darkMetalMat);
    barrelMesh.position.set(0, isPistol ? recH * 0.1 : recH * 0.12, barrelStartZ - barrelLen * 0.5 + 0.04);
    root.add(barrelMesh);

    // Handguard / Pump Forend
    const pumpGroup = new THREE.Group();
    root.add(pumpGroup);

    if (!isPistol) {
      const hgLen = Math.min(barrelLen * 0.72, 0.32);
      const hgW = recW * 1.04;
      const hgH = recH * 0.86;
      const hgGeo = new THREE.BoxGeometry(hgW, hgH, hgLen);
      const hgMesh = new THREE.Mesh(
        hgGeo,
        v.handguardStyle === 'quadrail' ? darkMetalMat : furnitureMat
      );
      hgMesh.position.set(0, 0.004, barrelStartZ - hgLen * 0.5 + 0.02);

      if (v.handguardStyle === 'shotgun_pump') {
        // Under-barrel magazine tube for shotguns
        const tubeGeo = new THREE.CylinderGeometry(0.011, 0.011, barrelLen * 0.92, 10);
        tubeGeo.rotateX(Math.PI / 2);
        const tubeMesh = new THREE.Mesh(tubeGeo, darkMetalMat);
        tubeMesh.position.set(0, -0.012, barrelStartZ - barrelLen * 0.44);
        root.add(tubeMesh);

        // Sliding pump forend
        const pumpForendGeo = new THREE.CylinderGeometry(0.022, 0.022, 0.16, 12);
        pumpForendGeo.rotateX(Math.PI / 2);
        const pumpForend = new THREE.Mesh(pumpForendGeo, furnitureMat);
        pumpForend.position.set(0, -0.014, barrelStartZ - 0.15);
        pumpGroup.add(pumpForend);
      } else {
        root.add(hgMesh);
      }
    }

    // 4. Stock Assembly
    if (!isPistol && v.stockStyle !== 'none') {
      const stockZ = recL * 0.5 + 0.12;
      if (v.stockStyle === 'wire' || v.stockStyle === 'folded') {
        const rodGeo = new THREE.CylinderGeometry(0.006, 0.006, 0.22, 8);
        rodGeo.rotateX(Math.PI / 2);
        const rod = new THREE.Mesh(rodGeo, darkMetalMat);
        rod.position.set(0, 0.01, stockZ);
        root.add(rod);
        const buttGeo = new THREE.BoxGeometry(0.036, 0.095, 0.02);
        const butt = new THREE.Mesh(buttGeo, darkMetalMat);
        butt.position.set(0, -0.01, stockZ + 0.11);
        root.add(butt);
      } else {
        const stockGeo = new THREE.BoxGeometry(recW * 0.88, recH * 1.15, 0.24);
        const stockMesh = new THREE.Mesh(stockGeo, furnitureMat);
        stockMesh.position.set(0, -0.012, stockZ);
        root.add(stockMesh);
      }
    }

    // 5. Articulated Bolt / Slide Group (reciprocates on fire & bolt-slap)
    const boltGroup = new THREE.Group();
    root.add(boltGroup);
    if (isPistol) {
      if (v.isRevolver) {
        const cylGeo = new THREE.CylinderGeometry(0.022, 0.022, 0.048, 8);
        cylGeo.rotateX(Math.PI / 2);
        const cylMesh = new THREE.Mesh(cylGeo, chromeBoltMat);
        cylMesh.position.set(0, 0.004, -0.01);
        boltGroup.add(cylMesh);
      } else {
        const slideGeo = new THREE.BoxGeometry(recW * 1.05, recH * 0.72, recL * 1.02);
        const slideMesh = new THREE.Mesh(slideGeo, receiverMat);
        slideMesh.position.set(0, recH * 0.25, -0.005);
        boltGroup.add(slideMesh);
      }
    } else {
      // Ejection port bolt carrier + charging handle
      const portGeo = new THREE.BoxGeometry(0.008, 0.018, 0.068);
      const portMesh = new THREE.Mesh(portGeo, chromeBoltMat);
      portMesh.position.set(recW * 0.5 + 0.002, 0.012, -0.02);
      boltGroup.add(portMesh);

      const handleGeo = new THREE.BoxGeometry(0.028, 0.01, 0.014);
      const handleMesh = new THREE.Mesh(handleGeo, darkMetalMat);
      handleMesh.position.set(recW * 0.5 + 0.014, 0.014, -0.04);
      boltGroup.add(handleMesh);
    }

    // 6. Articulated Magazine Group (detaches on reload + tilts on [M] Mag Check!)
    const magazineGroup = new THREE.Group();
    const magZ = isPistol ? 0.035 : -0.045;
    const magY = -recH * 0.5;
    magazineGroup.position.set(0, magY, magZ);
    root.add(magazineGroup);

    const magMod = attachments.magazine?.modifiers;
    const extraLen = magMod?.magCapDelta ? 0.045 : 0;
    const magLen = v.magLength + extraLen;

    if (v.magLength > 0.04) {
      const magGeo = new THREE.BoxGeometry(recW * 0.68, magLen, 0.056);
      const magMesh = new THREE.Mesh(
        magGeo,
        weapon.id.startsWith('ka') ? furnitureMat : darkMetalMat
      );
      magMesh.position.set(0, -magLen * 0.48, -v.magCurvature * 0.025);
      magMesh.rotation.x = v.magCurvature * 0.28;
      magazineGroup.add(magMesh);
    }

    // Top visible brass cartridge inside magazine feed lips (visible when checking mag!)
    const brassMat = new THREE.MeshStandardMaterial({
      color: 0xd4af37,
      roughness: 0.25,
      metalness: 0.9,
    });
    const brassGeo = new THREE.CylinderGeometry(0.0055, 0.006, 0.038, 8);
    brassGeo.rotateX(Math.PI / 2);
    const brassBulletMesh = new THREE.Mesh(brassGeo, brassMat);
    brassBulletMesh.position.set(0, 0.005, 0);
    magazineGroup.add(brassBulletMesh);

    // 7. ATTACHMENTS: OPTICS & SIGHT ALIGNMENT
    const opticMod = attachments.optic?.modifiers;
    const opticType = opticMod?.opticType || 'iron';
    const topY = isPistol ? recH * 0.62 : recH * 0.5 + 0.01;
    let sightAlignY = topY + 0.022;

    if (opticType === 'iron') {
      // Front post with glowing green tritium night-sight dot
      const frontPostGeo = new THREE.BoxGeometry(0.004, 0.022, 0.006);
      const frontPost = new THREE.Mesh(frontPostGeo, darkMetalMat);
      const frontZ = isPistol ? -recL * 0.46 : barrelStartZ - barrelLen * 0.65;
      frontPost.position.set(0, topY + 0.011, frontZ);
      root.add(frontPost);

      const tritiumMat = new THREE.MeshBasicMaterial({ color: 0x33ff66 });
      const tritiumDot = new THREE.Mesh(new THREE.SphereGeometry(0.0022, 6, 6), tritiumMat);
      tritiumDot.position.set(0, topY + 0.021, frontZ + 0.003);
      root.add(tritiumDot);

      // Rear notch aperture (left & right ears)
      const rearZ = isPistol ? recL * 0.42 : recL * 0.35;
      const earGeo = new THREE.BoxGeometry(0.006, 0.02, 0.008);
      const earL = new THREE.Mesh(earGeo, darkMetalMat);
      earL.position.set(-0.009, topY + 0.01, rearZ);
      const earR = new THREE.Mesh(earGeo, darkMetalMat);
      earR.position.set(0.009, topY + 0.01, rearZ);
      root.add(earL, earR);

      sightAlignY = topY + 0.02;
    } else if (opticType === 'reddot' || opticType === 'holo') {
      const mountZ = isPistol ? 0.01 : 0.02;
      const housingW = opticType === 'holo' ? 0.042 : 0.034;
      const housingH = opticType === 'holo' ? 0.044 : 0.036;
      const baseGeo = new THREE.BoxGeometry(housingW, 0.012, 0.056);
      const baseMesh = new THREE.Mesh(baseGeo, darkMetalMat);
      baseMesh.position.set(0, topY + 0.006, mountZ);
      root.add(baseMesh);

      // Left, Right, Top hood walls (open center window!)
      const wallGeo = new THREE.BoxGeometry(0.004, housingH, 0.048);
      const wallL = new THREE.Mesh(wallGeo, darkMetalMat);
      wallL.position.set(-housingW * 0.46, topY + 0.012 + housingH * 0.5, mountZ);
      const wallR = new THREE.Mesh(wallGeo, darkMetalMat);
      wallR.position.set(housingW * 0.46, topY + 0.012 + housingH * 0.5, mountZ);
      const roofGeo = new THREE.BoxGeometry(housingW, 0.004, 0.048);
      const roof = new THREE.Mesh(roofGeo, darkMetalMat);
      roof.position.set(0, topY + 0.012 + housingH, mountZ);
      root.add(wallL, wallR, roof);

      // Illuminated Reticle inside the glass window
      const reticleCenterY = topY + 0.012 + housingH * 0.5;
      const dotMat = new THREE.MeshBasicMaterial({
        color: 0xff2222,
        side: THREE.DoubleSide,
      });
      const dotMesh = new THREE.Mesh(new THREE.CircleGeometry(0.0018, 12), dotMat);
      dotMesh.position.set(0, reticleCenterY, mountZ);
      root.add(dotMesh);

      if (opticType === 'holo') {
        const ringGeo = new THREE.RingGeometry(0.0065, 0.0078, 20);
        const ringMesh = new THREE.Mesh(ringGeo, dotMat);
        ringMesh.position.set(0, reticleCenterY, mountZ);
        root.add(ringMesh);
      }

      sightAlignY = reticleCenterY;
    } else if (opticType === 'acog' || opticType === 'sniper8x') {
      const scopeLen = opticType === 'sniper8x' ? 0.24 : 0.14;
      const scopeR = opticType === 'sniper8x' ? 0.022 : 0.019;
      const centerY = topY + 0.032;

      // Scope rings + open tube with crosshair
      const ringGeo = new THREE.TorusGeometry(scopeR, 0.004, 8, 18);
      const ringFront = new THREE.Mesh(ringGeo, darkMetalMat);
      ringFront.position.set(0, centerY, -scopeLen * 0.45);
      const ringRear = new THREE.Mesh(ringGeo, darkMetalMat);
      ringRear.position.set(0, centerY, scopeLen * 0.45);
      root.add(ringFront, ringRear);

      // Crosshair reticle wires inside scope
      const wireMat = new THREE.MeshBasicMaterial({
        color: opticType === 'acog' ? 0xff3322 : 0x22ff55,
      });
      const hWire = new THREE.Mesh(new THREE.BoxGeometry(scopeR * 1.7, 0.0008, 0.001), wireMat);
      hWire.position.set(0, centerY, 0);
      const vWire = new THREE.Mesh(new THREE.BoxGeometry(0.0008, scopeR * 1.7, 0.001), wireMat);
      vWire.position.set(0, centerY, 0);
      root.add(hWire, vWire);

      sightAlignY = centerY;
    }

    // 8. ATTACHMENTS: MUZZLE & SUPPRESSOR
    const muzzleMod = attachments.muzzle?.modifiers;
    const barrelTipZ = barrelStartZ - barrelLen + 0.04;
    let finalMuzzleZ = barrelTipZ;

    if (muzzleMod?.suppressed) {
      const supLen = isPistol ? 0.14 : 0.19;
      const supGeo = new THREE.CylinderGeometry(0.019, 0.019, supLen, 14);
      supGeo.rotateX(Math.PI / 2);
      const supMesh = new THREE.Mesh(supGeo, darkMetalMat);
      supMesh.position.set(0, barrelMesh.position.y, barrelTipZ - supLen * 0.5);
      root.add(supMesh);
      finalMuzzleZ = barrelTipZ - supLen;
    } else {
      const brakeLen = 0.045;
      const brakeGeo = new THREE.CylinderGeometry(barrelRadius * 1.35, barrelRadius * 1.25, brakeLen, 10);
      brakeGeo.rotateX(Math.PI / 2);
      const brakeMesh = new THREE.Mesh(brakeGeo, darkMetalMat);
      brakeMesh.position.set(0, barrelMesh.position.y, barrelTipZ - brakeLen * 0.5);
      root.add(brakeMesh);
      finalMuzzleZ = barrelTipZ - brakeLen;
    }

    // 9. ATTACHMENTS: FOREGRIP
    const gripId = attachments.grip?.id;
    if (!isPistol && gripId === 'grip_vert') {
      const vgGeo = new THREE.CylinderGeometry(0.014, 0.015, 0.095, 10);
      const vgMesh = new THREE.Mesh(vgGeo, furnitureMat);
      vgMesh.position.set(0, -recH * 0.5 - 0.045, barrelStartZ - 0.14);
      root.add(vgMesh);
    } else if (!isPistol && gripId === 'grip_angled') {
      const agGeo = new THREE.BoxGeometry(0.028, 0.032, 0.095);
      const agMesh = new THREE.Mesh(agGeo, furnitureMat);
      agMesh.position.set(0, -recH * 0.5 - 0.012, barrelStartZ - 0.14);
      agMesh.rotation.x = 0.25;
      root.add(agMesh);
    }

    // 10. MUZZLE POINT, FLASH & EJECTION POINT
    const muzzlePoint = new THREE.Object3D();
    muzzlePoint.position.set(0, barrelMesh.position.y, finalMuzzleZ - 0.01);
    root.add(muzzlePoint);

    const ejectionPoint = new THREE.Object3D();
    ejectionPoint.position.set(recW * 0.6, 0.015, -0.02);
    root.add(ejectionPoint);

    const flashMat = new THREE.MeshBasicMaterial({
      color: 0xffbb44,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const flashGeo = new THREE.DodecahedronGeometry(0.075, 0);
    const muzzleFlashMesh = new THREE.Mesh(flashGeo, flashMat);
    muzzlePoint.add(muzzleFlashMesh);

    const muzzleFlashLight = new THREE.PointLight(0xffaa33, 0, 9, 2);
    muzzlePoint.add(muzzleFlashLight);

    // 11. TACTICAL RAIL MODULE (Flashlight SpotLight + 3D Laser Beam)
    const tacMod = attachments.tactical?.modifiers;
    const hasFlashlight = tacMod?.hasFlashlight !== false;
    const hasLaser = tacMod?.hasLaser !== false;
    const laserHex = tacMod?.laserColor || 0x22ff66;

    const peqZ = isPistol ? barrelStartZ - 0.04 : barrelStartZ - 0.18;
    const peqX = isPistol ? 0 : recW * 0.58;
    const peqY = isPistol ? -recH * 0.45 : 0.005;

    const peqBox = new THREE.Mesh(
      new THREE.BoxGeometry(0.024, 0.022, 0.068),
      darkMetalMat
    );
    peqBox.position.set(peqX, peqY, peqZ);
    root.add(peqBox);

    const flashlightSpot = new THREE.SpotLight(0xfff6e5, 0, 42, Math.PI / 5.2, 0.45, 1.3);
    flashlightSpot.position.set(peqX, peqY, peqZ - 0.035);
    const flashlightTarget = new THREE.Object3D();
    flashlightTarget.position.set(peqX, peqY, peqZ - 10);
    root.add(flashlightSpot);
    root.add(flashlightTarget);
    flashlightSpot.target = flashlightTarget;

    // 3D Volumetric Laser Beam & World Hit Dot
    const laserMat = new THREE.MeshBasicMaterial({
      color: laserHex,
      transparent: true,
      opacity: hasLaser ? 0.42 : 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const laserGeo = new THREE.CylinderGeometry(0.001, 0.001, 1, 6);
    laserGeo.rotateX(Math.PI / 2);
    laserGeo.translate(0, 0, -0.5); // anchor at origin and extend along -Z
    const laserBeamMesh = new THREE.Mesh(laserGeo, laserMat);
    laserBeamMesh.position.set(peqX, peqY, peqZ - 0.034);
    root.add(laserBeamMesh);

    const dotMat = new THREE.MeshBasicMaterial({
      color: laserHex,
      blending: THREE.AdditiveBlending,
      depthTest: false,
    });
    const laserDotMesh = new THREE.Mesh(new THREE.SphereGeometry(0.018, 8, 8), dotMat);
    laserDotMesh.visible = hasLaser;

    // 12. "TRUE BODY" CONNECTED OPERATOR GLOVES & FOREARMS
    const gloveMat = new THREE.MeshStandardMaterial({
      color: 0x2b2925,
      roughness: 0.78,
      metalness: 0.08,
    });
    const sleeveMat = new THREE.MeshStandardMaterial({
      color: 0x3b4238, // Ranger green tactical combat shirt sleeve
      roughness: 0.85,
      metalness: 0.05,
    });

    const rightHandGroup = new THREE.Group();
    const rGlove = new THREE.Mesh(new THREE.BoxGeometry(0.052, 0.068, 0.075), gloveMat);
    rGlove.position.set(0.01, -recH * 0.5 - 0.038, gripMesh.position.z + 0.01);
    const rArm = new THREE.Mesh(new THREE.BoxGeometry(0.065, 0.065, 0.28), sleeveMat);
    rArm.position.set(0.055, -recH * 0.5 - 0.085, gripMesh.position.z + 0.16);
    rArm.rotation.y = -0.22;
    rArm.rotation.x = 0.25;
    rightHandGroup.add(rGlove, rArm);
    root.add(rightHandGroup);

    const leftHandGroup = new THREE.Group();
    const lHandZ = isPistol ? gripMesh.position.z - 0.01 : barrelStartZ - 0.14;
    const lGlove = new THREE.Mesh(new THREE.BoxGeometry(0.052, 0.062, 0.082), gloveMat);
    lGlove.position.set(-0.018, -recH * 0.5 - 0.025, lHandZ);
    const lArm = new THREE.Mesh(new THREE.BoxGeometry(0.064, 0.064, 0.34), sleeveMat);
    lArm.position.set(-0.095, -recH * 0.5 - 0.095, lHandZ + 0.17);
    lArm.rotation.y = 0.38;
    lArm.rotation.x = 0.28;
    leftHandGroup.add(lGlove, lArm);
    root.add(leftHandGroup);

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
      sightAlignLocal: new THREE.Vector3(0, sightAlignY, 0),
      muzzleFlashMesh,
      muzzleFlashLight,
      flashlightSpot,
      flashlightTarget,
      laserBeamMesh,
      laserDotMesh,
      hasLaser,
      hasFlashlight,
    };
  }
}
