/**
 * Stands in for elkjs, which mermaid loads only for a diagram that asks for `layout: elk`. elkjs is
 * EPL-2.0 without a secondary license, which cannot be combined with Stuga's AGPL, so the build
 * aliases it here and such a diagram shows mermaid's error instead of a drawing.
 */
export default class ELK {
  constructor() {
    throw new Error("The ELK layout is not available in Stuga. Remove `layout: elk` to draw the diagram.");
  }
}
