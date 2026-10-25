import { Mesh2MotionEngine } from './Mesh2MotionEngine'
import { SessionSerializer } from './lib/SessionSerializer'

export class CustomModelUploadBootstrap {
  public readonly mesh2motion_engine: Mesh2MotionEngine
  public readonly session: SessionSerializer

  constructor () {
    this.mesh2motion_engine = new Mesh2MotionEngine()
    this.session = new SessionSerializer(this.mesh2motion_engine)
  }
}

// instantiate the class to setup event listeners
const app = new CustomModelUploadBootstrap()

// Expose a small, host-agnostic API so an embedding environment can save and
// restore a full editing session. Not used by the standalone app itself.
;(window as any).mesh2motion = {
  engine: app.mesh2motion_engine,
  session: app.session
}
