# GameDrive Sales Planning Tool - Claude Code Starter Prompt

## Project Overview

Building an AI-powered sales planning platform for Game Drive (Utrecht, Netherlands). Replacing manual Excel workflow with interactive Gantt chart system for managing game sales across Steam, PlayStation, Xbox, Nintendo, and Epic platforms.

**Client:** Game Drive (Utrecht, Netherlands)
**Primary Contact:** Alisa Jefimova
**Budget:** $5,000 fixed price (30-day MVP)
**Deadline:** January 22, 2025

---

## Quick Start Commands

```bash
# Start development server (port 3003)
cd /Users/joshuamartin/GameDrive
npm run dev -- -p 3003

# Build for production
npm run build

# Push changes to GitHub (triggers auto-deploy to Vercel)
git add .
git commit -m "description of changes"
git push origin main
```

---

## Technical Stack

| Component | Technology | Notes |
|-----------|------------|-------|
| Frontend | Next.js 14 + TypeScript | App Router |
| Styling | **CSS Modules** | NOT Tailwind - had silent compilation failures on Vercel |
| Database | Supabase PostgreSQL | Project: znueqcmlqfdhetnierno (eu-west-1) |
| Hosting | Vercel | Auto-deploys from GitHub |
| Repository | github.com/GameDriveNL/Game-Drive-Sales-Planning | main branch |

---

## URLs & Resources

- **Production:** https://platform.game-drive.nl/
- **Analytics:** https://platform.game-drive.nl/analytics
- **GitHub:** https://github.com/GameDriveNL/Game-Drive-Sales-Planning
- **Local Dev:** http://localhost:3003
- **Supabase Dashboard:** https://supabase.com/dashboard/project/znueqcmlqfdhetnierno

---

## Key Files

```
app/
├── page.tsx              # Main Gantt timeline (most complex page)
├── page.module.css       # Gantt chart styling
├── analytics/
│   └── page.tsx          # Steam Analytics Dashboard
├── clients/page.tsx      # Client management CRUD
├── platforms/page.tsx    # Platform settings (cooldowns, colors)
├── settings/page.tsx     # API key management
├── export/page.tsx       # Excel export functionality
├── components/
│   ├── GanttChart.tsx    # Reusable timeline component
│   └── *.tsx             # Various UI components
lib/
├── supabase.ts           # Supabase client config
├── types.ts              # TypeScript type definitions
├── validation.ts         # Platform cooldown validation
├── dateUtils.ts          # Date manipulation helpers
└── undo-context.tsx      # Undo/redo state management
docs/
├── PROJECT_PROGRESS.md   # Progress tracker (UPDATE AFTER EACH SESSION)
└── DEVELOPMENT_WORKFLOW.md # Development patterns
```

---

## Database Schema

### Core Tables
- `clients` - Game publishers (TMG, Funselektor, WeirdBeard, tobspr, Rangatang)
- `games` - Games per client
- `products` - Products per game (base game, DLC, edition, soundtrack)
- `platforms` - Platform config (Steam, PS, Xbox, Nintendo, Epic with cooldowns)
- `sales` - Sale records linked to products and platforms
- `platform_events` - Steam seasonal sales, festivals, etc.

### Analytics Tables
- `steam_performance_data` - Daily performance metrics (revenue, units, regions)
- `performance_import_history` - Import tracking

---

## Critical Technical Notes

### CSS Framework
**USE CSS MODULES, NOT TAILWIND**
Tailwind had silent compilation failures on Vercel. All styling uses `.module.css` files.

### Row Heights for Timeline
**MUST use fixed `height` (not `min-height`)** for timeline row positioning calculations. Absolute positioning depends on exact pixel heights.

### Supabase Numeric Fields
**Returns STRINGS, not numbers**. Always use `toNumber()` helper for calculations:
```typescript
const toNumber = (val: unknown): number => {
  if (val === null || val === undefined) return 0;
  const num = typeof val === 'string' ? parseFloat(val) : Number(val);
  return isNaN(num) ? 0 : num;
};
```

### TypeScript Null vs Undefined
**`undefined` is NOT assignable to `null`**. Use nullish coalescing:
```typescript
value ?? null
```

### GitHub MCP for Complex Files
**Use `push_files` NOT `create_or_update_file`** for complex TypeScript files. The latter corrupts HTML entities (`&amp;` → `&amp;amp;`), breaking builds.

---

## Development Workflow

### Standard Flow
1. **Edit code** locally in `/Users/joshuamartin/GameDrive/`
2. **Test locally** at http://localhost:3003
3. **Commit & Push** to GitHub when ready
4. **Wait 2-3 minutes** for Vercel auto-deploy
5. **Verify** at https://platform.game-drive.nl/
6. **Update tracker** at `docs/PROJECT_PROGRESS.md`

### Best Practices
- Small commits with descriptive messages
- Always request screenshot verification after UI changes
- Deployment success ≠ visual correctness
- Use optimistic UI updates for CRUD (update state immediately, rollback on error)

---

## Current Feature Status (as of January 12, 2025)

### ✅ COMPLETE
- Interactive Gantt chart with 12-month timeline
- Platform sub-rows for each product (Steam, PS, Xbox, etc.)
- Drag & drop sale blocks with cooldown validation
- Click-drag to create new sales
- Edit/Delete sales with confirmation
- Copy/Paste sales functionality
- Filtering by client, product, platform
- Platform events (Steam Summer Sale, Winter Sale, etc.)
- Auto-generate sale calendar wizard
- Steam Analytics Dashboard with:
  - Summary stat cards
  - Revenue/Units charts
  - Region breakdown
  - Period comparison table
  - CSV import for Steam data
- Client management CRUD
- Platform settings (cooldowns, colors, approval flags)
- Excel export
- Settings/API key management
- Responsive design (mobile, tablet, desktop)

### 🔧 PENDING (Issues #4-7 from client feedback)
- Issue #4: Duration input flexibility (text field instead of slider)
- Issue #5: Timeline width resize by dragging
- Issue #6: Auto-generation of platform selections (import-driven)
- Issue #7: Edit platform colors directly
- Right-click paste on timeline (partially implemented)
- PowerPoint export (needs live client testing)

### 📋 DEFERRED (Post-MVP)
- Authentication/User login
- Historical discount tracking
- AI-based forecasting/predictions
- Bulk sale editing
- Planning ↔ Analytics integration

---

## UI/Visual Requirements

### Sale Block Shape
**Angled corners (CSS clip-path polygon)** - Sales don't start at midnight. NOT rectangles.

### Platform Colors
```css
--steam: #1b2838;      /* Dark blue */
--playstation: #0070d1; /* PlayStation blue */
--xbox: #107c10;        /* Xbox green */
--nintendo: #e60012;    /* Nintendo red */
--epic: #000000;        /* Epic black */
```

### Cooldown Visualization
Grayed striped pattern showing waiting periods between sales.

---

## Vercel Deployment Info

- **Team ID:** team_6piiLSU3y16pH8Kt0uAlDFUu
- **Project ID:** prj_G1cbQAX5nL5VDKO37D73HnHNHnnR
- **Production URL:** https://platform.game-drive.nl
- **Auto-deploy:** Enabled from GitHub main branch
- **Build time:** ~2-3 minutes

---

## Supabase Info

- **Project ID:** znueqcmlqfdhetnierno
- **Region:** eu-west-1
- **URL:** https://znueqcmlqfdhetnierno.supabase.co
- **Anon Key:** In `.env.local`

---

## Common Tasks

### Add a new page
1. Create folder in `app/` (e.g., `app/newpage/`)
2. Add `page.tsx` and `page.module.css`
3. Add navigation link in sidebar
4. Test locally, then push to GitHub

### Modify database schema
Use Supabase MCP:
```javascript
supabase:apply_migration({
  name: "descriptive_name",
  project_id: "znueqcmlqfdhetnierno",
  query: "SQL HERE"
})
```

### Debug Vercel deployment
Check build logs if deployment fails. Common issues:
- TypeScript errors (strict null checking)
- CSS import paths
- Missing environment variables

---

## Updating Trackers

After each work session, update:
1. **Local tracker:** `/Users/joshuamartin/GameDrive/docs/PROJECT_PROGRESS.md`
2. **Push to GitHub** to update remote tracker

Include:
- What was completed
- What issues were encountered
- What's next

---

## Contact Info

- **Client:** Game Drive (Utrecht, Netherlands)
- **Alisa Jefimova:** alisa@game-drive.nl
- **Stephanie:** stephanie@game-drive.nl

---

*Last Updated: January 14, 2025*
