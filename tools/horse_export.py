# Horse pipeline: turns the CC0 Blender horse into the game's GLB. Run with Blender 4.2 (see README):
#
#   blender -b --disable-autoexec --factory-startup "assets-source/horse/Horse Rigged All Gaits.blend" \
#           --python tools/horse_export.py -- public/models/horse.glb
#
# What it does:
#   - keeps the horse body and its deform bones; drops tack, teeth/gums, fur and the control rig
#   - rebuilds mane and tail (particle hair in the source) as a few hundred skinned ribbons
#   - uses the source's ready-made bay coat texture; flat colours for hooves, eyes and hair
#   - bakes each gait and the small head/tail fidgets to its own named animation clip
#   - prints the ground covered per stride of each gait (used in src/player/gaits.ts)
import random
import sys

import bmesh
import bpy
from mathutils import Vector, kdtree

OUT = sys.argv[sys.argv.index('--') + 1]
CLIPS = {
    'walk': 'horse.walk', 'trot': 'horse.trot', 'canter': 'horse.canter', 'gallop': 'horse.gallop',
    'headShake': 'horse.head.shake', 'headTossUp': 'horse.head.toss.up', 'headTossDown': 'horse.head.toss.down',
    'tailLeft': 'horse.tail.flick.left', 'tailRight': 'horse.tail.flick.right', 'tailUp': 'horse.tail.flick.up',
}
GAITS = ['walk', 'trot', 'canter', 'gallop']
HAIR = {  # particle system -> (ribbons to keep, width at root in metres)
    'horse.tail': (260, 0.022),
    'mane': (300, 0.02),
}

scene = bpy.context.scene
rig = bpy.data.objects['horse.rig']
horse = bpy.data.objects['horse']

# --- Stand the horse at the origin in its rest pose, with nothing animating it.
anim = rig.animation_data
for track in list(anim.nla_tracks):
    anim.nla_tracks.remove(track)
anim.action = None
for c in list(rig.constraints):
    rig.constraints.remove(c)
rig.location = (0, 0, 0)
for pb in rig.pose.bones:
    pb.location = (0, 0, 0)
    pb.rotation_quaternion = (1, 0, 0, 0)
    pb.rotation_euler = (0, 0, 0)
    pb.scale = (1, 1, 1)

# --- Mane and tail: read the combed guide hairs, keep a subset, turn each into a tapered ribbon.
rig.data.pose_position = 'REST'
for ps in horse.particle_systems:
    ps.settings.child_type = 'NONE'
    ps.use_hair_dynamics = False
for m in horse.modifiers:
    if m.type == 'PARTICLE_SYSTEM':
        m.show_viewport = m.particle_system.name in HAIR
    elif m.type != 'ARMATURE':
        m.show_viewport = False
depsgraph = bpy.context.evaluated_depsgraph_get()
evaluated = horse.evaluated_get(depsgraph)
strands = {}
for name in HAIR:
    ps = evaluated.particle_systems[name]
    mod = next(m for m in evaluated.modifiers if m.type == 'PARTICLE_SYSTEM' and m.particle_system.name == name)
    strands[name] = [[hk.co_object(evaluated, mod, p).copy() for hk in p.hair_keys] for p in ps.particles]
    print('##HAIR', name, 'guides', len(strands[name]), 'points each', len(strands[name][0]))

# Skin weights for hair: mane follows the skin it grows from, tail follows the tail bones.
tree = kdtree.KDTree(len(horse.data.vertices))
for v in horse.data.vertices:
    tree.insert(v.co, v.index)
tree.balance()
group_names = {g.index: g.name for g in horse.vertex_groups}
deform = {b.name for b in rig.data.bones if b.use_deform}


def skin_weights(co):
    _, index, _ = tree.find(co)
    w = [(group_names[g.group], g.weight) for g in horse.data.vertices[index].groups if group_names[g.group] in deform and g.weight > 0]
    w.sort(key=lambda x: -x[1])
    return w[:4] or [('DEF-spine.004', 1.0)]


to_horse = horse.matrix_world.inverted() @ rig.matrix_world
tail_bones = []
for i in range(1, 6):
    b = rig.data.bones[f'DEF-tail.00{i}']
    tail_bones.append((b.name, to_horse @ b.head_local, to_horse @ b.tail_local))


def tail_weights(co):
    scored = []
    for name, a, b in tail_bones:
        ab = b - a
        t = max(0.0, min(1.0, (co - a).dot(ab) / ab.length_squared))
        scored.append(((co - (a + ab * t)).length, name))
    scored.sort()
    (d0, n0), (d1, n1) = scored[0], scored[1]
    w0 = (d1 + 1e-4) / (d0 + d1 + 2e-4)
    return [(n0, w0), (n1, 1 - w0)]


rng = random.Random(7)
verts, faces, weights = [], [], []
for name, (keep, width) in HAIR.items():
    for strand in rng.sample(strands[name], min(keep, len(strands[name]))):
        tangent = (strand[1] - strand[0]).normalized()
        side = tangent.cross(Vector((rng.uniform(-1, 1), rng.uniform(-1, 1), rng.uniform(-1, 1)))).normalized()
        root = skin_weights(strand[0])
        base = len(verts)
        for i, p in enumerate(strand):
            half = side * (width * (1 - 0.75 * i / (len(strand) - 1)) / 2)
            w = tail_weights(p) if name == 'horse.tail' else root
            verts += [p - half, p + half]
            weights += [w, w]
            if i:
                k = base + 2 * i
                faces.append((k - 2, k - 1, k + 1, k))
hair_mesh = bpy.data.meshes.new('hair')
hair_mesh.from_pydata(verts, [], faces)
hair = bpy.data.objects.new('hair', hair_mesh)
horse.users_collection[0].objects.link(hair)
hair.parent = rig
hair.matrix_parent_inverse = horse.matrix_parent_inverse.copy()
hair.matrix_basis = horse.matrix_basis.copy()
for index, w in enumerate(weights):
    for bone, value in w:
        (hair.vertex_groups.get(bone) or hair.vertex_groups.new(name=bone)).add([index], value, 'REPLACE')
hair.modifiers.new('Armature', 'ARMATURE').object = rig


# --- Materials: one textured coat, flat colours for the rest.
def flat(name, rgb, roughness, image=None):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    bsdf = m.node_tree.nodes['Principled BSDF']
    bsdf.inputs['Base Color'].default_value = (*rgb, 1)
    bsdf.inputs['Roughness'].default_value = roughness
    if image:
        tex = m.node_tree.nodes.new('ShaderNodeTexImage')
        tex.image = image
        m.node_tree.links.new(tex.outputs['Color'], bsdf.inputs['Base Color'])
    return m


coat_image = next(n.image for n in bpy.data.materials['horse_body.brown_black'].node_tree.nodes if n.type == 'TEX_IMAGE' and 'Base Color' in n.image.name)
coat = flat('coat', (1, 1, 1), 0.55, coat_image)
hoof = flat('hoof', (0.02, 0.016, 0.013), 0.4)
eye = flat('eye', (0.012, 0.008, 0.006), 0.08)
hair_mat = flat('hair', (0.012, 0.01, 0.009), 0.6)
hair_mat.use_backface_culling = False  # ribbons are seen from both sides
hair_mesh.materials.append(hair_mat)

# --- Body mesh: drop the inside of the mouth (half the polygons, never seen), fur and helpers.
slot_names = [s.material.name if s.material else '' for s in horse.material_slots]
bm = bmesh.new()
bm.from_mesh(horse.data)
doomed = [f for f in bm.faces if slot_names[f.material_index] in ('horse_gums', 'horse_teeth')]
bmesh.ops.delete(bm, geom=doomed, context='FACES')
bm.to_mesh(horse.data)
bm.free()
horse.data.validate()
for i, name in enumerate(slot_names):
    horse.material_slots[i].material = {'horse_hooves': hoof, 'horse.eyes': eye, 'horse_cornea': eye}.get(name, coat)
for m in list(horse.modifiers):
    if m.type != 'ARMATURE':
        horse.modifiers.remove(m)
if horse.data.shape_keys:
    horse.shape_key_clear()
print('##MESH body tris', sum(len(p.vertices) - 2 for p in horse.data.polygons), 'hair tris', len(faces) * 2)

# --- Measure how far the body travels per stride (hoof speed while planted x cycle length).
rig.data.pose_position = 'POSE'
hooves = ['DEF-f_toe.L', 'DEF-f_toe.R', 'DEF-r_toe.L', 'DEF-r_toe.R']
for clip in GAITS:
    action = bpy.data.actions[CLIPS[clip]]
    anim.action = action
    f0, f1 = (int(v) for v in action.frame_range)
    steps = (f1 - f0) * 4
    track = {h: [] for h in hooves}
    for s in range(steps + 1):
        frame = f0 + s / 4
        scene.frame_set(int(frame), subframe=frame % 1)
        for h in hooves:
            track[h].append(rig.matrix_world @ rig.pose.bones[h].tail)
    travelled = planted = 0
    for h in hooves:
        floor = min(p.z for p in track[h])
        for a, b in zip(track[h], track[h][1:]):
            if a.z < floor + 0.004 and b.z < floor + 0.004:
                travelled += abs(b.y - a.y)
                planted += 1
    print(f'##STRIDE {clip}: {travelled / planted * steps:.2f} m per cycle, cycle {(f1 - f0) / scene.render.fps:.3f} s, withers-ish height {max(v.co.z for v in horse.data.vertices) * rig.scale.z:.2f}')
anim.action = None

# --- One NLA track per clip: the exporter bakes each to the deform bones under the track's name.
# Each strip gets its own stretch of the timeline and no hold before/after, so no clip leaks into another.
start = 0
for clip, action_name in CLIPS.items():
    action = bpy.data.actions[action_name]
    track = anim.nla_tracks.new()
    track.name = clip
    strip = track.strips.new(clip, start, action)
    strip.extrapolation = 'NOTHING'
    start = int(strip.frame_end) + 20

bpy.ops.object.select_all(action='DESELECT')
for o in (rig, horse, hair):
    o.hide_set(False)
    o.select_set(True)
bpy.context.view_layer.objects.active = rig
bpy.ops.export_scene.gltf(
    filepath=OUT, export_format='GLB', use_selection=True, export_apply=False,
    export_animations=True, export_animation_mode='NLA_TRACKS', export_force_sampling=True, export_anim_slide_to_zero=True,
    export_def_bones=True, export_optimize_animation_size=True, export_skins=True, export_morph=False,
    export_image_format='JPEG', export_jpeg_quality=85, export_tangents=False,
    export_cameras=False, export_lights=False,
)
print('##DONE', OUT)
