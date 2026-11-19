# @scenegrade/svelte

Svelte 5 components for [scenegrade](../../README.md).

```svelte
<script>
  import { ScenePlayer } from '@scenegrade/svelte';
</script>

<div style="height: 80vh"><ScenePlayer src="/shot.mov" /></div>
```

| Prop | |
|---|---|
| `src` | anything `Player.load` accepts |
| `layout` | `'full'` (review tool) or `'compact'` (embedded) |
| `bind:controller` | the `PlayerController` (`ctl.player`, `ctl.update(...)`, reactive `ctl.state` / `ctl.settings`) |
| `player` | use an existing headless `Player` |
| `allowDrop`, `panel`, `options`, `onready` | |

The individual parts (`Viewer`, `Transport`, `Timeline`, `TopBar`, `ToolRail`, `Scope`, `ScopesPanel`,
`ColorPanel`, `InfoPanel`) all take `ctl` so you can build your own layout. Theme with the CSS
variables in `tokens.css`. Apache-2.0.
