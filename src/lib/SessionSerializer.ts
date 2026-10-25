import { type Mesh2MotionEngine } from '../Mesh2MotionEngine'
import { ProcessStep } from './enums/ProcessStep'
import { Utility } from './Utilities'
import BoneTransformState from './interfaces/BoneTransformState'
import { Vector3, Scene, Mesh } from 'three'
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js'

// Cap on the base64 GLB we inline into project data. The platform's save POST
// is bounded by PHP post_max_size (8MB) and project data counts against the
// user's storage quota, so we keep the geometry payload well under that. Models
// larger than this skip geometry capture (everything else still saves; restore
// will just decline that one model).
const MAX_GLB_BASE64_BYTES = 5_000_000

/**
 * Captures and restores a full editing session.
 *
 * Mesh2Motion ships with no save/load; this adds it. The strategy is
 * "serialize primitives + re-run the deterministic steps" rather than storing
 * computed state: skin weights and the default animation library are fully
 * reproducible from (model + posed skeleton + selections), so we only persist
 * the source model identity, skeleton choice, the user's bone pose, a few edit
 * flags, and the selected animation NAMES. Restore replays the pipeline by
 * driving the app's own UI controls (the wiring we know works) plus a couple of
 * public engine calls.
 *
 * M1 scope: REFERENCE models (the built-in Human/Fox/etc.). Uploaded-model
 * geometry capture is M2 (the raw bytes are discarded by the loader today).
 *
 * This class is host-agnostic: it knows nothing about the platform. The
 * platform adapter calls serialize()/restore() and handles persistence.
 */

interface Vec3JSON { x: number, y: number, z: number }
interface BoneTransformJSON { name: string, position: Vec3JSON, rotation: Vec3JSON, scale: Vec3JSON }

export interface SessionData {
  version: number
  step: string // ProcessStep enum value
  // For reference models: path is the dropdown value (e.g. models/model-fox.glb).
  // For uploads: path is '' and glb holds a base64 GLB of the unrigged mesh
  // (re-exported, since the original upload bytes are discarded by the loader).
  model: { source: 'reference' | 'upload', path: string, ext: string, glb?: string }
  skeleton: { type: string, hand: string, scale: number }
  editFlags: { headWeight: boolean, headHeight: number, mirror: boolean }
  boneTransforms: BoneTransformJSON[]
  animationNames: string[]
}

const STEP_RANK: Record<string, number> = {
  [ProcessStep.LoadModel]: 0,
  [ProcessStep.LoadSkeleton]: 1,
  [ProcessStep.EditSkeleton]: 2,
  [ProcessStep.WeightSkin]: 3,
  [ProcessStep.AnimationsListing]: 4,
  [ProcessStep.StepExportToFile]: 5
}

export class SessionSerializer {
  constructor (private readonly engine: Mesh2MotionEngine) {}

  // ---- Save -------------------------------------------------------------

  public async serialize (): Promise<SessionData | null> {
    const e = this.engine
    const step = e.process_step
    if (step === ProcessStep.LoadModel) return null // nothing loaded yet

    const src = e.load_model_step.last_loaded_source
    if (src === null) return null

    // For uploaded models the original bytes are gone, so re-export the current
    // (unrigged) mesh to a GLB and inline it. For reference models we just keep
    // the dropdown path and re-fetch on restore.
    const isUpload = src.is_upload
    let modelGlb: string | undefined
    if (isUpload) {
      modelGlb = await this.export_unrigged_glb() ?? undefined
      if (modelGlb === undefined) {
        console.warn('[SessionSerializer] uploaded model geometry not saved (too large or export failed); session will restore everything except the model')
      }
    }

    return {
      version: 1,
      step,
      model: {
        source: isUpload ? 'upload' : 'reference',
        path: isUpload ? '' : src.path, // don't persist the giant upload data URL
        ext: src.file_extension,
        glb: modelGlb
      },
      skeleton: {
        type: String(e.load_skeleton_step.skeleton_type()),
        hand: this.read_select('#hand-skeleton-selection') ?? 'all-fingers',
        scale: e.load_skeleton_step.skeleton_scale()
      },
      editFlags: {
        headWeight: this.safe(() => e.edit_skeleton_step.use_head_weight_correction(), false),
        headHeight: this.safe(() => e.edit_skeleton_step.get_preview_plane_height(), 1.4),
        mirror: this.safe(() => e.edit_skeleton_step.is_mirror_mode_enabled(), false)
      },
      boneTransforms: this.capture_bone_transforms(),
      animationNames: this.capture_animation_selection()
    }
  }

  private capture_bone_transforms (): BoneTransformJSON[] {
    return this.safe(() => {
      const skeleton = this.engine.edit_skeleton_step.skeleton()
      if (skeleton === undefined || skeleton.bones === undefined || skeleton.bones.length === 0) return []
      return Utility.store_bone_transforms(skeleton).map((b) => ({
        name: b.name,
        position: { x: b.position.x, y: b.position.y, z: b.position.z },
        rotation: { x: b.rotation.x, y: b.rotation.y, z: b.rotation.z },
        scale: { x: b.scale.x, y: b.scale.y, z: b.scale.z }
      }))
    }, [])
  }

  private capture_animation_selection (): string[] {
    return this.safe(() => {
      const search = this.engine.animations_listing_step.animation_search
      if (search === null) return []
      return search.get_selected_animations().map((a) => a.name)
    }, [])
  }

  // ---- Restore ----------------------------------------------------------

  public async restore (data: SessionData): Promise<void> {
    if (data === null || data === undefined || data.version !== 1) return
    // Validity: reference models need a path; uploads need stored geometry.
    if (data.model.source === 'reference' && data.model.path === '') {
      console.warn('[SessionSerializer] reference model has no path; skipping', data.model); return
    }
    if (data.model.source === 'upload' && (data.model.glb === undefined || data.model.glb === '')) {
      console.warn('[SessionSerializer] uploaded model has no saved geometry; skipping', data.model); return
    }

    const e = this.engine
    const targetRank = STEP_RANK[data.step] ?? 0
    console.log('[SessionSerializer] restoring session ->', data.step, data)

    // STAGE 1: load the model. modelLoaded advances to LoadSkeleton.
    if (data.model.source === 'upload') {
      const glb = data.model.glb
      if (glb === undefined || glb === '') {
        console.warn('[SessionSerializer] uploaded model has no saved geometry; cannot restore'); return
      }
      // Re-import the re-exported GLB straight through the loader (same path
      // uploads use). A data: URL is accepted by GLTFLoader.
      e.load_model_step.load_model_file('data:model/gltf-binary;base64,' + glb, 'glb')
    } else {
      this.set_select('#model-selection', data.model.path)
      this.click('#load-model-button')
    }
    if (!await this.wait_until(() => e.process_step === ProcessStep.LoadSkeleton, 20000)) {
      console.warn('[SessionSerializer] model did not finish loading'); return
    }
    // Restore the skeleton SELECTION (dropdown + hand + scale) at the
    // LoadSkeleton step. This brings back the preview skeleton even when the
    // session was saved here (before "Edit Skeleton" was clicked).
    const hasSkeleton = data.skeleton.type !== '' && data.skeleton.type !== 'none'
    if (hasSkeleton) {
      this.set_select('#skeleton-selection', data.skeleton.type)
      this.set_select('#hand-skeleton-selection', data.skeleton.hand)
      this.set_range('#scale-skeleton-input', data.skeleton.scale)
    }
    if (targetRank <= STEP_RANK[ProcessStep.LoadSkeleton]) return

    // STAGE 2: advance into the skeleton editor. Selecting a skeleton kicks off
    // an async preview load; the "Edit Skeleton" button stays disabled until
    // that resolves, so we wait for it to enable before clicking (a .click() on
    // a disabled button is a no-op).
    if (!await this.click_when_enabled('#load-skeleton-button', 20000)) {
      console.warn('[SessionSerializer] Edit Skeleton button never enabled'); return
    }
    if (!await this.wait_until(() =>
      e.process_step === ProcessStep.EditSkeleton &&
      this.safe(() => e.edit_skeleton_step.skeleton()?.bones?.length > 0, false), 20000)) {
      console.warn('[SessionSerializer] skeleton did not finish loading'); return
    }

    // STAGE 3: restore the user's bone pose + edit flags.
    if (data.boneTransforms.length > 0) {
      Utility.restore_bone_transforms(e.edit_skeleton_step.skeleton(), data.boneTransforms.map(this.to_bone_state))
      this.safe(() => e.edit_skeleton_step.dispatchEvent(new CustomEvent('skeletonTransformed')), undefined)
    }
    this.safe(() => e.edit_skeleton_step.set_use_head_weight_correction(data.editFlags.headWeight), undefined)
    this.safe(() => e.edit_skeleton_step.set_preview_plane_height(data.editFlags.headHeight), undefined)
    this.safe(() => e.edit_skeleton_step.set_mirror_mode_enabled(data.editFlags.mirror), undefined)

    if (targetRank <= STEP_RANK[ProcessStep.EditSkeleton]) return

    // STAGE 4: bind pose -> skin -> animations listing (all driven by this button).
    if (!await this.click_when_enabled('#action_bind_pose', 20000)) {
      console.warn('[SessionSerializer] Bind Pose button never enabled'); return
    }
    if (!await this.wait_until(() =>
      e.animations_listing_step.animation_search !== null &&
      this.safe(() => e.animations_listing_step.animation_clips().length > 0, false), 25000)) {
      console.warn('[SessionSerializer] animations did not finish loading'); return
    }

    // STAGE 5: re-check the saved animations by name (drives the real checkboxes).
    this.apply_animation_selection(data.animationNames)
    console.log('[SessionSerializer] restore complete at', e.process_step)
  }

  private apply_animation_selection (names: string[]): void {
    this.safe(() => {
      const wanted = new Set(names)
      const clips = this.engine.animations_listing_step.animation_clips() // index-aligned with checkbox values
      const container = document.querySelector('#animations-items')
      if (container === null) return
      const checkboxes = container.querySelectorAll('input[type="checkbox"]')
      checkboxes.forEach((node) => {
        const cb = node as HTMLInputElement
        const idx = parseInt(cb.value)
        const should_check = !isNaN(idx) && clips[idx] !== undefined && wanted.has(clips[idx].name)
        if (cb.checked !== should_check) {
          cb.checked = should_check
          cb.dispatchEvent(new Event('change', { bubbles: true }))
        }
      })
    }, undefined)
  }

  // ---- helpers ----------------------------------------------------------

  private to_bone_state = (b: BoneTransformJSON): BoneTransformState =>
    new BoneTransformState(
      b.name,
      new Vector3(b.position.x, b.position.y, b.position.z),
      new Vector3(b.rotation.x, b.rotation.y, b.rotation.z),
      new Vector3(b.scale.x, b.scale.y, b.scale.z)
    )

  // Re-export the current unrigged mesh to a binary GLB, base64-encoded.
  // Returns null on failure or if it exceeds the inline size cap.
  private async export_unrigged_glb (): Promise<string | null> {
    try {
      const source = this.engine.load_model_step.model_meshes()
      if (source === undefined || source === null) return null

      // Build a CLEAN static scene: by the edit/skin steps the source geometry
      // carries skinIndex/skinWeight from binding. Exporting those without a
      // skeleton produces a malformed skinned mesh that yields NaN positions
      // when re-skinned on restore. So we clone each mesh's geometry, strip the
      // skin attributes, and emit plain (non-skinned) meshes with baked world
      // transforms.
      const scene = new Scene()
      source.updateMatrixWorld(true)
      source.traverse((obj) => {
        const anyObj = obj as any
        if (anyObj.isMesh === true && anyObj.geometry !== undefined) {
          const geo = anyObj.geometry.clone()
          geo.deleteAttribute('skinIndex')
          geo.deleteAttribute('skinWeight')
          const mesh = new Mesh(geo, anyObj.material)
          mesh.applyMatrix4(anyObj.matrixWorld)
          mesh.name = anyObj.name
          scene.add(mesh)
        }
      })
      if (scene.children.length === 0) return null

      const exporter = new GLTFExporter()
      const buffer: ArrayBuffer = await new Promise((resolve, reject) => {
        exporter.parse(
          scene,
          (result) => { resolve(result as ArrayBuffer) },
          (err) => { reject(err) },
          { binary: true, embedImages: true, onlyVisible: false }
        )
      })
      const b64 = this.array_buffer_to_base64(buffer)
      if (b64.length > MAX_GLB_BASE64_BYTES) {
        console.warn(`[SessionSerializer] exported model is ${(b64.length / 1e6).toFixed(1)}MB (base64); over the ${(MAX_GLB_BASE64_BYTES / 1e6).toFixed(0)}MB cap`)
        return null
      }
      return b64
    } catch (err) {
      console.warn('[SessionSerializer] GLB export failed', err)
      return null
    }
  }

  // Chunked base64 encode (avoids String.fromCharCode stack overflow on MB-sized buffers).
  private array_buffer_to_base64 (buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer)
    const CHUNK = 0x8000
    let binary = ''
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)))
    }
    return btoa(binary)
  }

  private read_select (selector: string): string | null {
    const el = document.querySelector(selector) as HTMLSelectElement | null
    return el === null ? null : el.value
  }

  private set_select (selector: string, value: string): void {
    const el = document.querySelector(selector) as HTMLSelectElement | null
    if (el === null) return
    el.value = value
    el.dispatchEvent(new Event('change', { bubbles: true }))
  }

  private set_range (selector: string, value: number): void {
    const el = document.querySelector(selector) as HTMLInputElement | null
    if (el === null) return
    el.value = String(value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }

  private click (selector: string): void {
    const el = document.querySelector(selector) as HTMLElement | null
    if (el === null) { console.warn('[SessionSerializer] missing control', selector); return }
    el.click()
  }

  // Wait until a button exists and is enabled (some steps disable the "next"
  // button until an async preview/load resolves), then click it.
  private async click_when_enabled (selector: string, timeout_ms: number): Promise<boolean> {
    const ready = await this.wait_until(() => {
      const el = document.querySelector(selector) as HTMLButtonElement | null
      return el !== null && !el.disabled
    }, timeout_ms)
    if (!ready) return false
    ;(document.querySelector(selector) as HTMLElement).click()
    return true
  }

  private async wait_until (predicate: () => boolean, timeout_ms: number): Promise<boolean> {
    const start = performance.now()
    return await new Promise<boolean>((resolve) => {
      const tick = (): void => {
        if (this.safe(predicate, false)) { resolve(true); return }
        if (performance.now() - start > timeout_ms) { resolve(false); return }
        setTimeout(tick, 100)
      }
      tick()
    })
  }

  private safe<T> (fn: () => T, fallback: T): T {
    try { return fn() } catch { return fallback }
  }
}
