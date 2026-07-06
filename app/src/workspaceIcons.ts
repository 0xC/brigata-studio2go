// Curated per-workspace icon set (cozy-interior art). The stored `icon` value
// is a short key (e.g. "i07"); the asset lives at /workspace-icons/<key>.png.
export type WorkspaceIcon = { key: string; label: string }

export const WORKSPACE_ICONS: WorkspaceIcon[] = [
  { key: 'i01', label: 'House' },
  { key: 'i02', label: 'Guitar' },
  { key: 'i03', label: 'Synth' },
  { key: 'i04', label: 'Door' },
  { key: 'i05', label: 'Window' },
  { key: 'i06', label: 'TV' },
  { key: 'i07', label: 'Plant' },
  { key: 'i08', label: 'Tree' },
  { key: 'i09', label: 'Armchair' },
  { key: 'i10', label: 'Lamp' },
  { key: 'i11', label: 'Fireplace' },
  { key: 'i12', label: 'Candle' },
  { key: 'i13', label: 'Speakers' },
  { key: 'i14', label: 'Piano' },
  { key: 'i15', label: 'Water tower' },
  { key: 'i16', label: 'Ladder' },
  { key: 'i17', label: 'Bookshelf' },
  { key: 'i18', label: 'Desk' },
  { key: 'i19', label: 'Cushions' },
  { key: 'i20', label: 'Night' },
  { key: 'i21', label: 'Kiln' },
  { key: 'i22', label: 'Sewing machine' },
  { key: 'i23', label: 'Coat rack' },
  { key: 'i24', label: 'Wood stove' },
  { key: 'i25', label: 'Pendant light' },
  { key: 'i26', label: 'Houseplant' },
  { key: 'i27', label: 'Study' },
  { key: 'i28', label: 'Dresser' },
  { key: 'i29', label: 'Doorway' },
  { key: 'i30', label: 'Sunset window' },
  { key: 'i31', label: 'Retro TV' },
]

const ICON_KEYS = new Set(WORKSPACE_ICONS.map(i => i.key))

export function isWorkspaceIcon(icon: string | null | undefined): icon is string {
  return !!icon && ICON_KEYS.has(icon)
}

export function workspaceIconSrc(key: string): string {
  return `/workspace-icons/${key}.png`
}
