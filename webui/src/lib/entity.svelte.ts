/**
 * The entity context (registry/files/lib/entity.svelte.ts, 2026-09-01).
 *
 * THE ENTITY LAW — border is OBJECTHOOD. A bordered box asserts itself
 * as a solid object; inside an already-solid surface (a dialog panel, a
 * popover) every additional border is another object competing with its
 * container, and restraint says most of them should not exist. The law
 * makes that restraint MATHEMATICAL instead of per-component taste
 * (Owner ruling, 2026-09-01):
 *
 *   depth 0   page level — a control's border IS its object edge:
 *             visible (the floor of objecthood)
 *   depth ≥1  inside an entity — the GROUND dissolves (the entity's
 *             surface is the well's interior) but the well's hairline
 *             edge STAYS: r14-12, Owner — the edge is STRUCTURE, not
 *             objecthood, and a boundary must never ride the shadow
 *             alone (a field reads as an engraved well: crisp edge
 *             for extent, inherited ground, inset shadow for depth).
 *             The old full dissolve (border transparent too) and the
 *             depth-2 re-assert are retired with it
 *   force     提前消费 — [data-assert-border] on any part SPENDS the
 *             budget early: the ground back at any depth
 *   opt-out   [data-dissolve-border] — the old full dissolve on
 *             demand, for flush edge-to-edge fields (the palette's
 *             head: the edge there would double the panel's border)
 *
 * Background rides the same restraint: a dissolved shell shows the
 * ENTITY's ground through transparency; when a hint of ground is
 * wanted, backdrop-filter is the preferred tint (the separator's
 * contrast-ghost precedent) — never a second opaque fill.
 *
 * The technique is the Context channel (the context-plugin-system
 * family): entities ACCUMULATE depth through Svelte context — every
 * provideEntity() call reads the ambient depth and writes depth + 1,
 * so nesting is automatic. The number lands on the entity root as
 * data-jx-entity={depth} for entity.css to key on (REAL DOM hooks).
 *
 * Hairlines are NOT entity borders: a 1px structural rule (the dialog
 * head/foot separators) organizes; it does not objectify. The law
 * governs object edges only.
 */
import { getContext, setContext } from 'svelte';
import './entity.css';

export interface EntityContext {
  /** the accumulated entity depth at this subtree (1 = first entity) */
  readonly depth: number;
}

const ENTITY_KEY = Symbol('jx-entity');

/**
 * Establish an entity — call in a solid-surface root's init (dialog
 * panels, popovers, sheets). Reads the ambient depth, accumulates +1,
 * and returns the depth to stamp on the root: data-jx-entity={depth}.
 */
export function provideEntity(): number {
  const ambient = getContext<EntityContext | undefined>(ENTITY_KEY);
  const depth = (ambient?.depth ?? 0) + 1;
  setContext<EntityContext>(ENTITY_KEY, {
    get depth() {
      return depth;
    },
  });
  return depth;
}

/** The ambient entity depth — 0 at page level (no entity above). */
export function getEntityDepth(): number {
  return getContext<EntityContext | undefined>(ENTITY_KEY)?.depth ?? 0;
}
