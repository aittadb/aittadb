# Vinext image-size compatibility adapter

This private workspace package implements only Vinext's build-time `imageSize(buffer)` dependency contract. It delegates parsing to `image-dimensions` and intentionally does not expose the broader vulnerable `image-size` parser surface.

Keep the npm override and compatibility tests until Vinext adopts a non-vulnerable upstream dependency. Remove this package in the same reviewed task as that upgrade.
