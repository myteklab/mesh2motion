# Mesh2Motion, as built for mytekdev.com

[Mesh2Motion](https://mesh2motion.org) rigs a 3D model with a skeleton and applies
ready-made animations to it, in the browser. It is by Scott Petrovic and
contributors ([source](https://github.com/Mesh2Motion/mesh2motion-app)). The code is
MIT licensed (LICENSE-MIT.MD) and so are our changes. Upstream's own models, rigs
and animations are CC0 (LICENSE-CC0.MD).

This repository holds the copy that students open on mytekdev.com.

- `main` is the built app we serve, exactly as deployed.
- `source` is the source it was built from: upstream commit
  [a9bf18a](https://github.com/Mesh2Motion/mesh2motion-app/commit/a9bf18a6007d7e12d197657f023f77a5e33473fe)
  (2026-06-01), plus one commit of our changes.

## What we changed

1. **Saving a session.** `src/lib/SessionSerializer.ts` captures the model, skeleton,
   bone pose and chosen animations, and restores them. The embedding page reaches it
   through `window.mesh2motion`.
2. **Export to the host.** Before a download, the app fires a cancelable
   `mesh2motion:exported` event carrying the file, so the embedding page can keep it.
3. **Runs from a subfolder.** Image, animation and rig paths are relative.
4. **Smaller things.** A Change Model button, a short "How it works" note on the
   first step, a fix for retargeting onto skeletons with other rest angles, and a
   fixed bounding sphere for the joint points. The post-download dialog, which sends
   a star rating to upstream's survey server, is not shown.
5. **Build environment.** Upstream's `vite.config.js` passed all of `process.env`
   to the bundle. Ours passes only the two values the app reads.

Left out of `source`: `.github/` and `venmo.png` (the author's payment QR code,
which the app never shows).

## Building it

```
git checkout source
npm ci
npm run build
```

`dist/` matches `main` byte for byte, apart from `test-files/`, which we do not
serve.

## Models

The extra characters under `models-variation/` carry their own licenses, credited in
the app and in `src/lib/RigModelVariations.ts`: Quaternius and Kenney (CC0), Tysan
Tan (CC BY-SA 4.0), Blender Studio and David Revoy (CC BY). The sample clips in
`animations/CarnegieMellonAnimations/` come from the CMU motion capture library.

The page that embeds the app on mytekdev.com, the script that connects it to the
site, and the gallery preview are separate programs that use the hooks above. They
are not part of this repository.
