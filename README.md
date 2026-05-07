# GameDrive Sales Planning Tool 🎮

## Overview

Professional sales planning platform for game publishers managing Steam, PlayStation, Nintendo, Xbox, and Epic sales campaigns. Built for Game Drive (Utrecht, Netherlands) with multi-client architecture and platform cooldown management.

**🔥 LIVE: https://platform.game-drive.nl/**

---

## Documentation

| Document | Description |
|----------|-------------|
| [Project Progress](docs/PROJECT_PROGRESS.md) | Detailed tracker of completed features, current status, and next steps |
| [Development Workflow](docs/DEVELOPMENT_WORKFLOW.md) | Feedback loops, patterns, and best practices for development |

---

## Features

### ✅ Completed (Phase 1)
- **Interactive Gantt Chart**: 12-month visual timeline with drag-and-drop scheduling
- **Platform Rules Engine**: Automatic cooldown validation for all platforms
- **Multi-Client Architecture**: Data isolation for TMG, Funselektor, WeirdBeard, tobspr, Rangatang
- **Full CRUD Operations**: Create, edit, delete sales with real-time validation
- **Optimistic UI**: Instant feedback with server-side validation
- **Product Manager**: Full client/game/product hierarchy management
- **Filtering System**: Filter by client and game
- **Status Tracking**: Planned → Submitted → Confirmed → Live → Ended

### 🚧 Next Phase
- **Steam API Integration**: Automated performance data import
- **Excel Export**: Match GameDrive's existing column format
- **Analytics Dashboard**: Revenue trends, performance comparison

---

## Tech Stack

- **Frontend**: Next.js 14 + TypeScript + CSS Modules
- **Database**: Supabase (PostgreSQL + RLS)
- **Hosting**: Vercel (auto-deploy from GitHub)
- **UI**: Custom components with @dnd-kit for drag-and-drop

---

## Platform Cooldowns

| Platform | Cooldown | Color |
|----------|----------|-------|
| Steam Custom | 30 days | #1b2838 |
| Steam Seasonal | 0 days | #1b2838 |
| PlayStation | 28 days | #003791 |
| Xbox | 30 days | #107c10 |
| Nintendo | 28-30 days | #e60012 |
| Epic | 30 days | #2f2f2f |
| GOG/Humble/Fanatical | 0 days | Various |

---

## Quick Start

### Environment Setup
```bash
cp .env.example .env.local
# Add your Supabase credentials
```

### Local Development
```bash
npm install
npm run dev
# Open http://localhost:3000
```

### Deployment
Automatic via Vercel on push to `main` branch.

---

## Project Structure

```
app/
├── components/          # React components
│   ├── GanttChart.tsx   # Main timeline view
│   ├── SaleBlock.tsx    # Draggable sale blocks
│   ├── EditSaleModal.tsx
│   ├── AddSaleModal.tsx
│   ├── ProductManager.tsx
│   └── SalesTable.tsx
├── api/sales/           # API routes
├── planning/            # Planning page
└── page.tsx             # Main dashboard

lib/
├── supabase.ts          # Database client
├── types.ts             # TypeScript interfaces
└── validation.ts        # Sale validation logic

docs/
├── PROJECT_PROGRESS.md  # Progress tracker
└── DEVELOPMENT_WORKFLOW.md  # Dev patterns
```

---

## Key Technical Decisions

1. **CSS Modules over Tailwind**: Tailwind had silent compilation failures on Vercel
2. **Optimistic UI**: All operations update instantly, rollback on error
3. **TypeScript Strict**: Catches errors at compile time
4. **Screenshot Verification**: Deployment success ≠ visual correctness

---

## Client Information

**Game Drive (Utrecht, Netherlands)**
- Budget: $5,000 fixed price
- Timeline: 30-day MVP
- Clients: TMG, Funselektor, WeirdBeard, tobspr, Rangatang

---

## Repository

- **GitHub**: https://github.com/GameDriveNL/Game-Drive-Sales-Planning
- **Supabase**: Project ID `znueqcmlqfdhetnierno` (eu-west-1)
- **Vercel**: Auto-deploys from main branch

---

Built with ❤️ for Game Drive by [AI West](https://aiwest.co)
