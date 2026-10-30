// SPIKE, not shipped (docs/OUTFIT_BUILDER_SPIKE.md): build a look out of the game's own clothing pieces on one of OUR copies, at run time.
//
// Three small operations on the components of an entity that is already assembled. Each is called once, on demand, when a copy changes
// its look (never per frame), by Lua on our own spawned copy only. Nothing here holds a component alive and nothing is written to disk.
//   ConvaiOutfitToggle(name, on)               show or hide one of the look's own pieces (a jacket, gloves, a belt)
//   ConvaiOutfitTint(name, appearance)         another mesh appearance of the same mesh (the "no_dirt" clothes of Panam's shirt and trousers)
//   ConvaiOutfitAdd(like, name, mesh, app)     one more piece: a copy of a sibling garment of the same entity (it carries the skinning and
//                                              transform bindings the sibling has), pointed at another mesh the game ships
// The pieces are found by the component names the game's own .app definitions use (scripts/Inspect-OutfitMeshes.mjs lists them).
// Without Codeware the methods are stand-ins that say no, so the scripts still compile.
@if(ModuleExists("Codeware"))
@addMethod(GameObject)
public func ConvaiOutfitFind(name: CName) -> ref<IComponent> {
  for component in this.GetComponents() {
    if Equals(component.name, name) { return component; };
  };
  return null;
}

@if(ModuleExists("Codeware"))
@addMethod(GameObject)
public func ConvaiOutfitToggle(name: CName, on: Bool) -> Bool {
  let component = this.ConvaiOutfitFind(name);
  if !IsDefined(component) { return false; };
  component.Toggle(on);
  return true;
}

@if(ModuleExists("Codeware"))
@addMethod(GameObject)
public func ConvaiOutfitTint(name: CName, appearance: CName) -> Bool {
  let component = this.ConvaiOutfitFind(name);
  if !IsDefined(component) { return false; };
  return component.ChangeAppearance(appearance);
}

@if(ModuleExists("Codeware"))
@addMethod(GameObject)
public func ConvaiOutfitAdd(like: CName, name: CName, mesh: String, appearance: CName) -> Bool {
  if IsDefined(this.ConvaiOutfitFind(name)) { return true; };
  let source = this.ConvaiOutfitFind(like) as entSkinnedMeshComponent;
  if !IsDefined(source) { return false; };
  let piece = source.Clone() as entSkinnedMeshComponent;
  if !IsDefined(piece) { return false; };
  piece.name = name;
  piece.mesh *= ResRef.FromString(mesh);
  piece.meshAppearance = appearance;
  piece.isEnabled = true;
  this.AddComponent(piece);
  return piece.LoadAppearance();
}

@if(!ModuleExists("Codeware"))
@addMethod(GameObject)
public func ConvaiOutfitToggle(name: CName, on: Bool) -> Bool {
  return false;
}

@if(!ModuleExists("Codeware"))
@addMethod(GameObject)
public func ConvaiOutfitTint(name: CName, appearance: CName) -> Bool {
  return false;
}

@if(!ModuleExists("Codeware"))
@addMethod(GameObject)
public func ConvaiOutfitAdd(like: CName, name: CName, mesh: String, appearance: CName) -> Bool {
  return false;
}
