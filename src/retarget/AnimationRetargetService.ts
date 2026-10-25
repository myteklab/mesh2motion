import {
  AnimationClip, QuaternionKeyframeTrack,
  VectorKeyframeTrack, Scene, Group, type SkinnedMesh,
  type Skeleton, AnimationMixer, Quaternion, Vector3, type Object3D, type Bone
} from 'three'
import { RetargetUtils, type TrackNameParts } from './RetargetUtils.ts'
import { TargetBoneMappingType } from './steps/StepBoneMapping.ts'
import { SkeletonType } from '../lib/enums/SkeletonType.ts'
import { Retargeter } from './human-retargeting/Retargeter.ts'
import { Rig } from './human-retargeting/Rig.ts'
import { HumanChainConfig } from './human-retargeting/HumanChainConfig.ts'

// AnimationRetargetService - Shared service for retargeting animations from one skeleton to another
// Used by both RetargetAnimationPreview and RetargetAnimationListing
export class AnimationRetargetService {
  private static instance: AnimationRetargetService | null = null

  // #region GETTER/SETTER
  /**
   * Get/set for the skeleton type. This will be the source of truth
   * for other classes to grab this data
   */
  private source_armature: Group = new Group()
  private skeleton_type: SkeletonType = SkeletonType.None
  private target_armature: Scene = new Scene()

  private target_skinned_meshes: SkinnedMesh[] = []
  private target_mapping_type: TargetBoneMappingType = TargetBoneMappingType.Custom
  private bone_mappings: Map<string, string> = new Map<string, string>()

  public set_bone_mappings (mappings: Map<string, string>): void {
    this.bone_mappings = mappings
  }

  public get_bone_mappings (): Map<string, string> {
    return this.bone_mappings
  }

  public clear_bone_mappings (): void {
    this.bone_mappings.clear()
  }

  public reset_target_mapping_type (): void {
    this.set_target_mapping_type(TargetBoneMappingType.Custom)
  }

  public set_source_armature (armature: Group): void {
    this.source_armature = armature
  }

  public get_source_armature (): Group {
    return this.source_armature
  }

  public set_target_armature (new_armature: Scene): void {
    this.target_armature = new_armature

    // re-calculate skinned meshes from target armature scene
    this.target_skinned_meshes = []
    this.target_armature.traverse((child) => {
      if (child.type === 'SkinnedMesh') {
        this.target_skinned_meshes.push(child as SkinnedMesh)
      }
    })
  }

  public get_target_skinned_meshes (): SkinnedMesh[] {
    return this.target_skinned_meshes
  }

  public get_target_armature (): Scene {
    return this.target_armature
  }

  public set_skeleton_type (type: SkeletonType): void {
    this.skeleton_type = type
  }

  public get_skeleton_type (): SkeletonType {
    return this.skeleton_type
  }

  public set_target_mapping_type (type: TargetBoneMappingType): void {
    this.target_mapping_type = type
  }

  public get_target_mapping_type (): TargetBoneMappingType {
    return this.target_mapping_type
  }

  // #endregion

  private constructor () {}

  // #region PUBLIC METHODS

  public static getInstance (): AnimationRetargetService {
    if (AnimationRetargetService.instance === null) {
      AnimationRetargetService.instance = new AnimationRetargetService()
    }
    return AnimationRetargetService.instance
  }

  /**
   * Retarget an animation clip using bone mappings
   * @param source_clip - The original animation clip from the source skeleton
   * @returns A new animation clip retargeted for the target skeleton
   */
  public retarget_animation_clip (source_clip: AnimationClip): AnimationClip {
    const new_tracks: Array<QuaternionKeyframeTrack | VectorKeyframeTrack> = [] // store new retargeted tracks

    // if there are no bone mappings, return the source clip as there is nothing to retarget
    if (this.bone_mappings.size === 0) {
      console.warn('No bone mappings available for retargeting. Returning source clip clone.')
      return source_clip.clone()
    }

    // ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
    // if the source skeleton is of type human, try tuse the human retargeting system
    // we ignore Mesh2Motion type since that is identical to the source and does not need retargeting
    if (this.skeleton_type === SkeletonType.Human && this.target_mapping_type !== TargetBoneMappingType.Mesh2Motion) {
      console.log('Using Human Retargeter for retargeting animation clip:', source_clip.name, this.target_mapping_type)
      return this.apply_human_swing_twist_retargeting(source_clip, this.target_mapping_type)
    }

    // A skeleton of the model's own (not one Mesh2Motion made): its bones rest turned
    // their own way and are their own lengths, so copying the source's rotations and
    // positions as they are bends it out of shape. Carry over how far each bone turns
    // from rest instead.
    if (this.target_mapping_type !== TargetBoneMappingType.Mesh2Motion) {
      const moved = this.apply_rest_delta_retargeting(source_clip)
      if (moved !== null) return moved
    }

    // ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
    // Besides the above special case, the standard retargeting will just be bone mapping applied
    // Maybe in the future we can do other more advanced things.

    const reverse_mappings = RetargetUtils.reverse_bone_mapping(this.bone_mappings)

    // Process each track in the source animation
    source_clip.tracks.forEach((track) => {
      // Parse the track name to get the bone name and property
      // Track names are typically in format: "boneName.property" or ".bones[boneName].property"
      const track_parts: TrackNameParts | null = RetargetUtils.parse_track_name_for_metadata(track.name)
      if (track_parts === null) {
        return
      }

      const source_bone_name = String(track_parts.bone_name)
      const track_property = String(track_parts.property)

      // Check if this bone is mapped to any target bones
      const target_bone_names = reverse_mappings.get(source_bone_name)
      if (target_bone_names === undefined || target_bone_names.length === 0) {
        return // Skip unmapped bones
      }

      // Create a track for each target bone this source bone maps to. Will mostly just rename
      // a bone with the mapping
      target_bone_names.forEach((target_bone_name) => {
        // track name is in the format of "boneName.property"
        const new_track_name = `${target_bone_name}.${track_property}`

        const times_copy = Float32Array.from(track.times as ArrayLike<number>)
        const values_copy = Float32Array.from(track.values as ArrayLike<number>)

        if (track_property === 'quaternion') {
          const new_track = new QuaternionKeyframeTrack(new_track_name, times_copy, values_copy)
          new_tracks.push(new_track)
        } else if (track_property === 'position' || track_property === 'scale') {
          const new_track = new VectorKeyframeTrack(new_track_name, times_copy, values_copy)
          new_tracks.push(new_track)
        } else {
          console.warn('This track contains unsupported property for retargeting:', track_property)
        }
      })
    })

    // Create the retargeted animation clip
    const retargeted_clip = new AnimationClip(`${source_clip.name}`, source_clip.duration, new_tracks)

    console.log(`Retargeted animation: ${source_clip.name} (${new_tracks.length} tracks)`)
    return retargeted_clip
  }

  // #endregion

  // #region PRIVATE METHODS

  /**
   * Retarget by rest-pose difference: play the source clip on a copy of the source
   * skeleton and, frame by frame, give each mapped target bone the same turn in the
   * world away from its own rest pose that its source bone makes from the source rest
   * pose. Unmapped bones keep their rest pose relative to their parent. The root moves
   * by the source root's travel, scaled by the two skeletons' root heights. Returns
   * null when there is nothing to work with, and the caller renames tracks as before.
   */
  private apply_rest_delta_retargeting (source_clip: AnimationClip): AnimationClip | null {
    const source_skeleton: Skeleton | null = RetargetUtils.create_skeleton_from_group_object(this.source_armature)
    if (source_skeleton === null || this.target_skinned_meshes.length === 0) return null
    const src: Skeleton = RetargetUtils.clone_skeleton(source_skeleton)
    const tgt: Skeleton = RetargetUtils.clone_skeleton(this.target_skinned_meshes[0].skeleton)
    const top = (o: Object3D): Object3D => { let n = o; while (n.parent !== null) n = n.parent; return n }
    const src_top = top(src.bones[0]); const tgt_top = top(tgt.bones[0])
    src_top.updateMatrixWorld(true); tgt_top.updateMatrixWorld(true)

    const world_q = (b: Object3D): Quaternion => b.getWorldQuaternion(new Quaternion())
    const world_p = (b: Object3D): Vector3 => b.getWorldPosition(new Vector3())
    const src_by_name = new Map<string, Bone>(src.bones.map(b => [b.name, b]))
    const src_rest = new Map<Bone, Quaternion>(src.bones.map(b => [b, world_q(b)]))
    const tgt_rest = new Map<Bone, Quaternion>(tgt.bones.map(b => [b, world_q(b)]))
    const is_bone = (o: Object3D | null): boolean => o !== null && o.type === 'Bone'

    // target bones, parents before children
    const order: Bone[] = []
    const visit = (b: Bone): void => { order.push(b); b.children.filter(c => c.type === 'Bone').forEach(c => visit(c as Bone)) }
    tgt.bones.filter(b => !is_bone(b.parent)).forEach(visit)
    const tgt_root = order[0]
    const root_source = src_by_name.get(this.bone_mappings.get(tgt_root.name) ?? '')
    const src_root_rest = root_source !== undefined ? world_p(root_source) : null
    const tgt_root_rest = world_p(tgt_root)
    const height = (p: Vector3 | null, of: Object3D): number => (p === null ? 0 : p.y - world_p(top(of)).y)
    const scale = src_root_rest !== null && Math.abs(height(src_root_rest, root_source as Bone)) > 1e-6
      ? height(tgt_root_rest, tgt_root) / height(src_root_rest, root_source as Bone)
      : 1

    const mixer = new AnimationMixer(src_top)
    const action = mixer.clipAction(source_clip)
    action.play()
    const frames = Math.max(2, Math.ceil(source_clip.duration * 30) + 1)
    const times = new Float32Array(frames)
    const quats = new Map<Bone, Float32Array>(order.map(b => [b, new Float32Array(frames * 4)]))
    const root_pos = new Float32Array(frames * 3)
    const world_now = new Map<Bone, Quaternion>()

    for (let f = 0; f < frames; f++) {
      const t = source_clip.duration * f / (frames - 1)
      times[f] = t
      mixer.setTime(t)
      src_top.updateMatrixWorld(true)
      world_now.clear()
      for (const b of order) {
        const rest = tgt_rest.get(b) as Quaternion
        const parent_rest = is_bone(b.parent) ? tgt_rest.get(b.parent as Bone) as Quaternion : world_q(b.parent as Object3D)
        const parent_now = is_bone(b.parent) ? world_now.get(b.parent as Bone) as Quaternion : parent_rest
        const s = src_by_name.get(this.bone_mappings.get(b.name) ?? '')
        let now: Quaternion
        if (s !== undefined) {
          const turn = world_q(s).multiply((src_rest.get(s) as Quaternion).clone().invert())
          now = turn.multiply(rest)
        } else {
          now = parent_now.clone().multiply(parent_rest.clone().invert().multiply(rest))
        }
        world_now.set(b, now)
        const local = parent_now.clone().invert().multiply(now)
        local.toArray(quats.get(b) as Float32Array, f * 4)
      }
      // the root travels as the source root does, scaled to this skeleton
      const at = tgt_root_rest.clone()
      if (root_source !== undefined && src_root_rest !== null) at.add(world_p(root_source).sub(src_root_rest).multiplyScalar(scale))
      const parent = tgt_root.parent as Object3D
      parent.worldToLocal(at)
      at.toArray(root_pos, f * 3)
    }
    action.stop(); mixer.uncacheRoot(src_top)

    const tracks: Array<QuaternionKeyframeTrack | VectorKeyframeTrack> = order.map(b => new QuaternionKeyframeTrack(`${b.name}.quaternion`, times, quats.get(b) as Float32Array))
    tracks.push(new VectorKeyframeTrack(`${tgt_root.name}.position`, times, root_pos))
    console.log(`Rest-pose retargeting: ${source_clip.name}, ${order.length} bones, root scaled ${scale.toFixed(3)}`)
    return new AnimationClip(source_clip.name, source_clip.duration, tracks)
  }

  private apply_human_swing_twist_retargeting (source_clip: AnimationClip, target_mapping_type: TargetBoneMappingType): AnimationClip {
    // the retargeter needs Skeleton inputs for both source and target.
    // the source armature is a Group, so we need to convert to a THREE.Skeleton before we can continue
    const source_skeleton: Skeleton | null = RetargetUtils.create_skeleton_from_group_object(this.source_armature)
    if (source_skeleton === null) {
      console.error('Failed to extract source skeleton from source armature for Human Retargeter.')
      return source_clip.clone()
    }

    if (this.target_skinned_meshes.length === 0) {
      console.error('No target skinned meshes available for Human Retargeter.')
      return source_clip.clone()
    }

    // we don't want to mutate/modify the original target skeleton since it is shared
    // across the app and will create issues as we change animations for retargeting later.
    const detached_target_skeleton: Skeleton = RetargetUtils.clone_skeleton(this.target_skinned_meshes[0].skeleton)

    // create a custom "Rig" for the source and the target skeletons
    const source_rig: Rig = new Rig(source_skeleton)
    const target_rig: Rig = new Rig(detached_target_skeleton)

    // if it is a known bone mapping, we can grab the preset config
    // if not, we will need to manually build the config from the bone mappings
    if (target_mapping_type === TargetBoneMappingType.Mixamo) {
      source_rig.fromConfig(HumanChainConfig.mesh2motion_config)
      target_rig.fromConfig(HumanChainConfig.mixamo_config)
    } else if (target_mapping_type === TargetBoneMappingType.Custom ||
               target_mapping_type === TargetBoneMappingType.Rigify) {
      const custom_source_config = HumanChainConfig.build_custom_source_config(this.get_bone_mappings())
      const custom_target_config = HumanChainConfig.build_custom_target_config(custom_source_config, this.get_bone_mappings())

      // set the custom rigs from the generated configs
      source_rig.fromConfig(custom_source_config)
      target_rig.fromConfig(custom_target_config)
    }

    const retargeter: Retargeter = new Retargeter(source_rig, target_rig, source_clip)

    // TODO: experiment with the additives later with T-pose correction
    // retargeter.additives.push(
    //     (Ref.addAxis  = new AxisAdditive( 'armL', 'y', 0 * Math.PI / 180 )),
    //     (Ref.addTwist = new ChainTwistAdditive( 'armR', 0 * Math.PI / 180 )),
    // );

    // Initialize the retargeter with a small delta
    retargeter.update(0.001)

    // Bake the retargeted animation into keyframe tracks
    // 30 fps for input animations is usually sufficient for now
    const retargeted_tracks: Array<QuaternionKeyframeTrack | VectorKeyframeTrack> = retargeter.bake_animation_to_tracks(30)

    // Create and return the new retargeted animation clip
    const retargeted_clip = new AnimationClip(
      `${source_clip.name} RT`, // RT means retargeted
      source_clip.duration,
      retargeted_tracks
    )

    console.log(`Swing-Twist retargeting complete: ${source_clip.name} -> ${retargeted_clip.name}`)
    console.log('getting source clip before bone correction:', source_clip.tracks)
    console.log('getting retargeted clip:', retargeted_clip.tracks)

    return retargeted_clip
  }

  // #endregion
}
