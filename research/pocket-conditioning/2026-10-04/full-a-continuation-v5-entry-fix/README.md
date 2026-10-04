# Native dataset loader compatibility

This narrow source successor fixes the two legacy Tier A metadata checks exposed
by the actual final teacher `load_spec` call. New native development rows retain
their original metadata and may omit derived history labels. They still require
successful native corpus verification before model allocation. Explicit contrary
labels fail. Legacy corpus requirements are unchanged.

The complete reviewed patch is `runner-entry-fix.patch`. Only `runner.py` changes;
the other eighteen source files match the preceding V5 checkpoint. Manifest SHA256:
`c744133da50caab6a3d25110b619db9351bff0cbcc75527c944884836f50866a`.
Runner SHA256:
`79488c318b52b84654064e37fdf468f6b550346d2717e108da697ed399e8f294`.

The frozen dataset and numeric recipes are unchanged. This folder preserves code
only and does not install or promote a model. The actual final training entry
and Kaggle receipts remain separate execution evidence.
