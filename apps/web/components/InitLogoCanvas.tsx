'use client';

import type * as Three from 'three';

import { useEffect, useRef } from 'react';

const MODEL_DEPTH = 54;
const BEVEL_SIZE = 7.5;
const FLOW_BAND_COUNT = 5;
const ROTATE_SPEED_Y = 4300;
const ROTATE_SPEED_Z = 6800;
const FLOW_SPEED = 0.00032;
const GLASS_BREATH_SPEED = 0.00135;
const DRAG_ROTATION_DAMPING = 0.91;

function supportsReducedMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)');
}

export function InitLogoCanvas() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let disposed = false;
    let animationFrame = 0;
    let resizeObserver: ResizeObserver | null = null;
    let renderer: Three.WebGLRenderer | null = null;
    let scene: Three.Scene | null = null;
    let camera: Three.PerspectiveCamera | null = null;
    let logoGroup: Three.Group | null = null;
    let render: ((time: number) => void) | null = null;
    let cleanupPointerHandlers: (() => void) | null = null;
    const targetCanvas = canvas;
    const motionQuery = supportsReducedMotion();
    let reducedMotion = motionQuery.matches;

    async function setup() {
      const [three, { SVGLoader }] = await Promise.all([
        import('three'),
        import('three/examples/jsm/loaders/SVGLoader.js')
      ]);
      if (disposed) return;

      renderer = new three.WebGLRenderer({
        alpha: true,
        antialias: true,
        canvas: targetCanvas,
        powerPreference: 'high-performance',
        premultipliedAlpha: true
      });
      renderer.setClearColor(0x000000, 0);
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.outputColorSpace = three.SRGBColorSpace;
      renderer.toneMapping = three.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.7;

      scene = new three.Scene();
      camera = new three.PerspectiveCamera(34, 1, 0.1, 100);
      camera.position.set(0, 0, 4.8);

      const svg = await fetch('/monad-icon-vector-solid.svg')
        .then((response) => response.text())
        .then((source) => source.replaceAll('currentColor', '#ffffff'));
      if (disposed || !scene) return;

      const loader = new SVGLoader();
      const data = loader.parse(svg);
      logoGroup = new three.Group();

      const glassMaterial = new three.MeshPhysicalMaterial({
        color: new three.Color(0xbfefff),
        emissive: new three.Color(0x1f7fa8),
        emissiveIntensity: 0.14,
        attenuationColor: new three.Color(0x92ecff),
        attenuationDistance: 1.7,
        dispersion: 0.22,
        iridescence: 0.58,
        iridescenceIOR: 1.42,
        iridescenceThicknessRange: [180, 760],
        metalness: 0,
        roughness: 0.012,
        transmission: 0.82,
        thickness: 1.18,
        ior: 1.48,
        transparent: true,
        opacity: 0.52,
        specularColor: new three.Color(0xffffff),
        specularIntensity: 1,
        clearcoat: 1,
        clearcoatRoughness: 0.02,
        side: three.DoubleSide
      });

      const edgeMaterial = new three.MeshPhysicalMaterial({
        color: new three.Color(0xf3fdff),
        emissive: new three.Color(0xaeefff),
        emissiveIntensity: 0.52,
        attenuationColor: new three.Color(0xd9fbff),
        attenuationDistance: 1.25,
        dispersion: 0.14,
        iridescence: 0.36,
        iridescenceIOR: 1.5,
        iridescenceThicknessRange: [120, 540],
        metalness: 0,
        roughness: 0.028,
        transmission: 0.46,
        thickness: 0.78,
        ior: 1.5,
        transparent: true,
        opacity: 0.82,
        specularIntensity: 1,
        clearcoat: 1,
        clearcoatRoughness: 0.01,
        side: three.DoubleSide
      });

      const glowShells: Array<{
        mesh: Three.Mesh<Three.BufferGeometry, Three.MeshBasicMaterial>;
        phase: number;
        scale: number;
        opacity: number;
      }> = [];

      for (const path of data.paths) {
        const shapes = path.toShapes();
        for (const shape of shapes) {
          const geometry = new three.ExtrudeGeometry(shape, {
            bevelEnabled: true,
            bevelSegments: 8,
            bevelSize: BEVEL_SIZE,
            bevelThickness: BEVEL_SIZE,
            curveSegments: 18,
            depth: MODEL_DEPTH,
            steps: 1
          });
          geometry.computeVertexNormals();

          const mesh = new three.Mesh(geometry, [glassMaterial, edgeMaterial]);
          const glow = new three.Mesh(
            geometry.clone(),
            new three.MeshBasicMaterial({
              blending: three.AdditiveBlending,
              color: 0xbdefff,
              depthTest: false,
              depthWrite: false,
              opacity: 0.055,
              side: three.DoubleSide,
              transparent: true
            })
          );
          glow.scale.setScalar(1.012);
          glowShells.push({
            mesh: glow,
            opacity: 0.055,
            phase: glowShells.length * 0.47,
            scale: 1.012
          });
          const innerFlow = new three.Mesh(
            geometry.clone(),
            new three.MeshBasicMaterial({
              blending: three.AdditiveBlending,
              color: glowShells.length % 2 === 0 ? 0x54f8ff : 0xff66f2,
              depthTest: false,
              depthWrite: false,
              opacity: 0.034,
              side: three.DoubleSide,
              transparent: true
            })
          );
          innerFlow.scale.setScalar(0.992);
          glowShells.push({
            mesh: innerFlow,
            opacity: 0.034,
            phase: glowShells.length * 0.61 + 1.2,
            scale: 0.992
          });
          logoGroup.add(mesh);
          logoGroup.add(glow);
          logoGroup.add(innerFlow);
        }
      }

      const box = new three.Box3().setFromObject(logoGroup);
      const size = box.getSize(new three.Vector3());
      const center = box.getCenter(new three.Vector3());
      logoGroup.traverse((object) => {
        const mesh = object as Three.Mesh;
        mesh.geometry?.translate(-center.x, -center.y, -center.z);
      });
      const scale = 2.35 / Math.max(size.x, size.y);
      logoGroup.scale.setScalar(scale);

      logoGroup.rotation.x = Math.PI;
      logoGroup.rotation.y = reducedMotion ? -0.5 : -0.46;
      logoGroup.rotation.z = 0.015;
      scene.add(logoGroup);

      const flowMaskTexture = new three.TextureLoader().load('/monad-icon-vector-solid.svg');
      flowMaskTexture.colorSpace = three.SRGBColorSpace;
      const flowSurfaceMaterial = new three.ShaderMaterial({
        blending: three.AdditiveBlending,
        depthTest: false,
        depthWrite: false,
        side: three.DoubleSide,
        transparent: true,
        uniforms: {
          uMask: { value: flowMaskTexture },
          uTime: { value: 0 }
        },
        vertexShader: `
          varying vec2 vUv;

          void main() {
            vUv = uv;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `,
        fragmentShader: `
          uniform sampler2D uMask;
          uniform float uTime;
          varying vec2 vUv;

          float causticLine(vec2 uv, float speed, float offset) {
            float waveA = sin((uv.x * 6.4 + uv.y * 3.1 + uTime * speed + offset) * 6.28318);
            float waveB = sin((uv.x * -3.0 + uv.y * 7.2 - uTime * speed * 0.72 + offset * 1.7) * 6.28318);
            float waveC = sin((uv.x * 9.0 - uv.y * 4.3 + uTime * speed * 0.42 + offset * 0.4) * 6.28318);
            float field = waveA + waveB * 0.65 + waveC * 0.38;
            return smoothstep(1.42, 2.02, field);
          }

          void main() {
            float maskAlpha = texture2D(uMask, vUv).a;
            float edgeFade = smoothstep(0.03, 0.85, maskAlpha);
            float causticA = causticLine(vUv, 0.00018, 0.0);
            float causticB = causticLine(vUv.yx + vec2(0.13, -0.08), -0.00015, 1.9);
            float sweep = fract((vUv.x * 0.62 + vUv.y * 1.28) * 2.5 - uTime * 0.00011);
            float broadRefraction = smoothstep(0.0, 0.18, sweep) * (1.0 - smoothstep(0.22, 0.56, sweep));
            float glassPulse = 0.55 + 0.45 * sin(uTime * 0.0011 + vUv.x * 8.0 - vUv.y * 3.0);
            vec3 cyan = vec3(0.18, 0.98, 1.0);
            vec3 violet = vec3(0.62, 0.34, 1.0);
            vec3 rose = vec3(1.0, 0.26, 0.78);
            vec3 color = mix(cyan, rose, 0.5 + 0.5 * sin(uTime * 0.0009 + vUv.y * 9.0));
            color = mix(color, violet, causticB * 0.45);
            float alpha = maskAlpha * edgeFade * (
              causticA * 0.15 +
              causticB * 0.11 +
              broadRefraction * 0.16 +
              glassPulse * 0.035
            );
            gl_FragColor = vec4(color, alpha);
          }
        `
      });
      const flowSurface = new three.Mesh(new three.PlaneGeometry(size.x, size.y), flowSurfaceMaterial);
      flowSurface.position.z = MODEL_DEPTH * 0.72;
      logoGroup.add(flowSurface);

      const ambient = new three.HemisphereLight(0xc6efff, 0x0a1016, 1.35);
      scene.add(ambient);

      const keyLight = new three.DirectionalLight(0xffffff, 3.4);
      keyLight.position.set(-2.8, 2.6, 4.2);
      scene.add(keyLight);

      const rimLight = new three.DirectionalLight(0x86dcff, 2.2);
      rimLight.position.set(3.4, 1.2, 2.5);
      scene.add(rimLight);

      const lowerLight = new three.PointLight(0xb5f2ff, 1.5, 5);
      lowerLight.position.set(-1.4, -1.6, 2.3);
      scene.add(lowerLight);

      const highlight = new three.Mesh(
        new three.TorusGeometry(1.22, 0.006, 10, 160, Math.PI * 1.55),
        new three.MeshBasicMaterial({
          color: 0xffffff,
          opacity: 0.22,
          transparent: true,
          blending: three.AdditiveBlending,
          depthWrite: false
        })
      );
      highlight.rotation.set(0.06, 0.08, 0.62);
      highlight.position.set(-0.05, 0.03, MODEL_DEPTH * scale * 0.62);
      logoGroup.add(highlight);

      const flowBands: Array<{
        mesh: Three.Mesh<Three.TorusGeometry, Three.MeshBasicMaterial>;
        speed: number;
        phase: number;
      }> = [];

      const flowGroup = new three.Group();
      for (let index = 0; index < FLOW_BAND_COUNT; index++) {
        const geometry = new three.TorusGeometry(0.92 + index * 0.08, 0.012, 10, 220);
        const material = new three.MeshBasicMaterial({
          color: new three.Color(index % 2 === 0 ? 0x34f5ff : 0xff4cf5),
          opacity: 0.16,
          transparent: true,
          blending: three.AdditiveBlending,
          depthTest: false,
          depthWrite: false
        });
        const band = new three.Mesh(geometry, material);
        band.rotation.set(Math.PI / 2, 0, index * (Math.PI / 6));
        band.position.set((index - 1) * 0.06, 0, (index - 1) * 0.09);
        flowBands.push({
          mesh: band,
          speed: 0.22 + index * 0.13,
          phase: index * 0.72
        });
        flowGroup.add(band);
      }
      logoGroup.add(flowGroup);

      let isDragging = false;
      let activePointerId: number | null = null;
      let lastPointerX = 0;
      let lastPointerY = 0;
      let dragRotationX = 0;
      let dragRotationY = 0;

      function handlePointerDown(event: PointerEvent) {
        isDragging = true;
        activePointerId = event.pointerId;
        lastPointerX = event.clientX;
        lastPointerY = event.clientY;
        targetCanvas.setPointerCapture(event.pointerId);
        targetCanvas.style.cursor = 'grabbing';
      }

      function handlePointerMove(event: PointerEvent) {
        if (!isDragging || activePointerId !== event.pointerId) return;
        const dx = event.clientX - lastPointerX;
        const dy = event.clientY - lastPointerY;
        lastPointerX = event.clientX;
        lastPointerY = event.clientY;
        dragRotationY += dx * 0.008;
        dragRotationX = Math.max(-0.95, Math.min(0.95, dragRotationX + dy * 0.006));
      }

      function handlePointerEnd(event: PointerEvent) {
        if (activePointerId !== event.pointerId) return;
        isDragging = false;
        activePointerId = null;
        if (targetCanvas.hasPointerCapture(event.pointerId)) {
          targetCanvas.releasePointerCapture(event.pointerId);
        }
        targetCanvas.style.cursor = 'grab';
      }

      targetCanvas.style.cursor = 'grab';
      targetCanvas.style.touchAction = 'none';
      targetCanvas.addEventListener('pointerdown', handlePointerDown);
      targetCanvas.addEventListener('pointermove', handlePointerMove);
      targetCanvas.addEventListener('pointerup', handlePointerEnd);
      targetCanvas.addEventListener('pointercancel', handlePointerEnd);
      cleanupPointerHandlers = () => {
        targetCanvas.removeEventListener('pointerdown', handlePointerDown);
        targetCanvas.removeEventListener('pointermove', handlePointerMove);
        targetCanvas.removeEventListener('pointerup', handlePointerEnd);
        targetCanvas.removeEventListener('pointercancel', handlePointerEnd);
      };

      function resize() {
        if (!camera || !renderer) return;
        const rect = targetCanvas.getBoundingClientRect();
        const width = Math.max(1, Math.floor(rect.width));
        const height = Math.max(1, Math.floor(rect.height));
        camera.aspect = width / height;
        camera.updateProjectionMatrix();
        renderer.setSize(width, height, false);
      }

      render = (time: number) => {
        if (!renderer || !scene || !camera || !logoGroup) return;

        const breath = 0.5 + Math.sin(time * GLASS_BREATH_SPEED) * 0.5;
        const slowBreath = 0.5 + Math.sin(time * GLASS_BREATH_SPEED * 0.47 + 0.8) * 0.5;
        flowSurfaceMaterial.uniforms.uTime.value = time;
        glassMaterial.emissiveIntensity = 0.14 + breath * 0.18;
        glassMaterial.opacity = 0.48 + slowBreath * 0.07;
        edgeMaterial.emissiveIntensity = 0.44 + breath * 0.36;
        edgeMaterial.opacity = 0.78 + slowBreath * 0.1;
        rimLight.intensity = 1.9 + breath * 0.85;
        lowerLight.intensity = 1.15 + slowBreath * 0.65;

        if (!reducedMotion) {
          if (!isDragging) {
            dragRotationX *= DRAG_ROTATION_DAMPING;
            dragRotationY *= DRAG_ROTATION_DAMPING;
          }
          logoGroup.rotation.x = Math.PI + dragRotationX;
          logoGroup.rotation.y = -0.44 + Math.sin(time / ROTATE_SPEED_Y) * 0.42 + dragRotationY;
          logoGroup.rotation.z = Math.sin(time / ROTATE_SPEED_Z) * 0.018;
          highlight.rotation.z = 0.62 + Math.sin(time / 4300) * 0.18;
        }

        for (const shell of glowShells) {
          const wave = 0.5 + Math.sin(time * FLOW_SPEED * 3 + shell.phase) * 0.5;
          const material = shell.mesh.material;
          shell.mesh.scale.setScalar(shell.scale + wave * 0.018);
          shell.mesh.position.z = Math.sin(time * FLOW_SPEED * 2.2 + shell.phase) * 4.2;
          material.opacity = shell.opacity + wave * 0.07;
        }

        for (const band of flowBands) {
          const wave = time * FLOW_SPEED * band.speed + band.phase;
          band.mesh.rotation.z = Math.cos(wave * 1.6) * 0.85;
          band.mesh.rotation.x = Math.PI / 2 + Math.sin(wave * 0.8) * 0.18;
          band.mesh.position.y = Math.sin(wave) * 0.18;
          band.mesh.position.z = Math.cos(wave * 0.5) * 0.2;
          band.mesh.material.opacity = 0.08 + Math.max(0, Math.sin(wave * 1.8)) * 0.2;
        }

        renderer.render(scene, camera);
        const renderFrame = render;
        if (renderFrame) {
          animationFrame = requestAnimationFrame(renderFrame);
        }
      };

      resizeObserver = new ResizeObserver(() => {
        resize();
        if (reducedMotion) render?.(0);
      });
      resizeObserver.observe(targetCanvas);
      resize();
      if (render) {
        animationFrame = requestAnimationFrame(render);
      }
    }

    function handleMotionChange(event: MediaQueryListEvent) {
      reducedMotion = event.matches;
      if (!logoGroup || !renderer || !scene || !camera) return;
      cancelAnimationFrame(animationFrame);
      if (reducedMotion) {
        logoGroup.rotation.y = -0.42;
        renderer.render(scene, camera);
        animationFrame = requestAnimationFrame((time) => {
          if (!logoGroup || !renderer || !scene || !camera) return;
          render?.(time);
        });
      } else {
        animationFrame = requestAnimationFrame((time) => {
          if (!logoGroup || !renderer || !scene || !camera) return;
          render?.(time);
        });
      }
    }

    motionQuery.addEventListener('change', handleMotionChange);
    void setup().catch(() => {});

    return () => {
      disposed = true;
      cancelAnimationFrame(animationFrame);
      motionQuery.removeEventListener('change', handleMotionChange);
      cleanupPointerHandlers?.();
      resizeObserver?.disconnect();
      scene?.traverse((object: Three.Object3D) => {
        const mesh = object as Three.Mesh;
        if (mesh.geometry) mesh.geometry.dispose();
        const material = mesh.material;
        if (Array.isArray(material)) {
          for (const entry of material) entry.dispose();
        } else {
          material?.dispose();
        }
      });
      renderer?.dispose();
    };
  }, []);

  return (
    <canvas
      className="h-[min(58vh,560px)] min-h-72 w-full max-w-xl"
      ref={canvasRef}
    />
  );
}
