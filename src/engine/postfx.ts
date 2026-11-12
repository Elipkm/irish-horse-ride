import * as THREE from 'three/webgpu';
import { float, pass, screenUV, smoothstep, uniform, vec2, vec3, vec4, length } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { dof } from 'three/addons/tsl/display/DepthOfFieldNode.js';
import { gradeTint } from '../world/atmosphere';

const KEY = 'horse.effects';

/**
 * Optional post effects: a soft bloom round the brightest parts of the sky and water, the time of
 * day's colour grade, a light vignette and, in photo mode, depth of field focused on the horse.
 * Off, the scene is drawn straight to the screen exactly as before. Tone mapping and colour space
 * are still applied by the renderer at the end (PostProcessing does it for us).
 */
export class PostFx {
  /** The rider's choice (the quality level can also switch the effects off). */
  wanted = true;
  /** Photo mode: add depth of field. */
  photo = false;
  /** Distance from the camera to what is in focus, in metres. */
  readonly focus = uniform(7);

  private readonly post: THREE.PostProcessing;
  private readonly normal: THREE.Node;
  private readonly portrait: THREE.Node;
  private shown: THREE.Node;
  private active = false;

  constructor(
    private readonly renderer: THREE.WebGPURenderer,
    private readonly scene: THREE.Scene,
    private readonly camera: THREE.Camera
  ) {
    try {
      this.wanted = localStorage.getItem(KEY) !== '0';
    } catch {
      // Default on.
    }
    this.post = new THREE.PostProcessing(renderer);
    const scenePass = pass(scene, camera);
    const color = scenePass.getTextureNode();

    const finish = (rgb: THREE.Node) => {
      const graded = vec3(rgb).mul(gradeTint);
      // Vignette: the corners fall away gently.
      const edge = length(screenUV.sub(vec2(0.5, 0.5)));
      const vignette = float(1).sub(smoothstep(0.38, 0.95, edge).mul(0.3));
      return vec4(graded.mul(vignette), 1);
    };
    // The bloom threshold is in scene units before tone mapping (exposure 0.5): only real highlights glow.
    const glow = bloom(color, 0.28, 0.55, 1.6);
    this.normal = finish(color.rgb.add(glow.rgb));

    const focused = dof(color, scenePass.getViewZNode(), this.focus, 0.0012, 0.01);
    const glowFocused = bloom(focused, 0.28, 0.55, 1.6);
    this.portrait = finish(focused.rgb.add(glowFocused.rgb));

    this.shown = this.normal;
    this.post.outputNode = this.shown;
  }

  setWanted(on: boolean) {
    this.wanted = on;
    try {
      localStorage.setItem(KEY, on ? '1' : '0');
    } catch {
      // Not fatal.
    }
  }

  /** `allowed`: the current quality level can afford the effects. */
  render(allowed: boolean) {
    this.active = allowed && this.wanted;
    if (!this.active) {
      this.renderer.render(this.scene, this.camera);
      return;
    }
    const want = this.photo ? this.portrait : this.normal;
    if (want !== this.shown) {
      this.shown = want;
      this.post.outputNode = want;
      this.post.needsUpdate = true;
    }
    this.post.render();
  }
}
