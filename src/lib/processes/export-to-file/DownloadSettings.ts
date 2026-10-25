import { SkeletonType } from '../../enums/SkeletonType.ts'

export enum BoneNamingStructure {
  Default = 'default',
  Mixamo = 'mixamo'
}

export class DownloadSettings extends EventTarget {
  private selected_bone_naming_structure: BoneNamingStructure = BoneNamingStructure.Default
  private dom_download_settings_popup: HTMLElement | null = null
  private dom_download_settings_toggle: HTMLButtonElement | null = null
  private dom_download_settings_panel: HTMLElement | null = null
  private dom_bone_naming_group: HTMLElement | null = null
  private dom_bone_naming_default_radio: HTMLInputElement | null = null

  constructor () {
    super()
    this.initialize_dom_elements()
    this.add_event_listeners()
  }

  public bone_naming_structure (): BoneNamingStructure {
    return this.selected_bone_naming_structure
  }

  // Download options currently only apply to human skeleton, so this will
  // show/hide the DOM download settings options on UI based on that.
  public update_download_settings_ui_visibility (skeleton_type: SkeletonType): void {
    // reset to default
    this.selected_bone_naming_structure = BoneNamingStructure.Default
    if (this.dom_bone_naming_default_radio !== null) {
      this.dom_bone_naming_default_radio.checked = true
    }

    const is_human_skeleton = skeleton_type === SkeletonType.Human

    if (this.dom_download_settings_popup !== null) {
      this.dom_download_settings_popup.style.display = is_human_skeleton ? 'inline-flex' : 'none'
      this.dom_download_settings_popup.setAttribute('aria-hidden', is_human_skeleton ? 'false' : 'true')
    }

    if (!is_human_skeleton) {
      this.set_popup_visibility(false)
    }
  }

  private initialize_dom_elements (): void {
    this.dom_download_settings_popup = document.querySelector('#download-settings-popup')
    this.dom_download_settings_toggle = document.querySelector('#download-settings-toggle')
    this.dom_download_settings_panel = document.querySelector('#download-settings')
    this.dom_bone_naming_group = document.querySelector('#download-bone-naming-group')
    this.dom_bone_naming_default_radio = document.querySelector('#bone-naming-default')
  }

  private add_event_listeners (): void {
    this.dom_download_settings_toggle?.addEventListener('click', () => {
      this.set_popup_visibility(this.dom_download_settings_panel?.hidden !== false)
    })

    document.addEventListener('click', (event: MouseEvent) => {
      if (this.dom_download_settings_panel?.hidden !== false) {
        return
      }

      const clicked_element = event.target as Node | null
      if (clicked_element === null) {
        return
      }

      if (this.dom_download_settings_popup?.contains(clicked_element) !== true) {
        this.set_popup_visibility(false)
      }
    })

    document.addEventListener('keydown', (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        this.set_popup_visibility(false)
      }
    })

    this.dom_bone_naming_group?.addEventListener('change', (event: Event) => {
      const selected_radio = event.target as HTMLInputElement | null

      if (selected_radio === null || selected_radio.name !== 'bone-naming-structure') {
        return
      }

      this.selected_bone_naming_structure =
        selected_radio.value === BoneNamingStructure.Mixamo
          ? BoneNamingStructure.Mixamo
          : BoneNamingStructure.Default

      this.dispatchEvent(new CustomEvent('bone-naming-structure-changed', {
        detail: { boneNamingStructure: this.selected_bone_naming_structure }
      }))
    })
  }

  private set_popup_visibility (is_visible: boolean): void {
    if (this.dom_download_settings_panel !== null) {
      this.dom_download_settings_panel.hidden = !is_visible
    }

    if (this.dom_download_settings_toggle !== null) {
      this.dom_download_settings_toggle.setAttribute('aria-expanded', is_visible ? 'true' : 'false')
    }
  }
}
