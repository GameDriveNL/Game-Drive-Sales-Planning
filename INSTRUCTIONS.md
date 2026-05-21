# Claude Code Instructions for GameDrive

You are working on the GameDrive Sales Planning Tool. This is a Next.js 14 application for managing video game sales across multiple platforms.

## Workflow

1. **Local Development:** http://localhost:3003
2. **Test changes locally first**
3. **Commit to GitHub** → Auto-deploys to Vercel
4. **Verify at:** https://platform.game-drive.nl/

## Critical Rules

- **USE CSS MODULES** (not Tailwind - compilation issues on Vercel)
- **Fixed heights** for timeline rows (not min-height)
- **Supabase returns strings** for numbers - use `toNumber()` helper
- **Use `push_files`** for GitHub, not `create_or_update_file`
- **Update tracker** after each session: `docs/PROJECT_PROGRESS.md`

## Key Files
- `app/page.tsx` - Main Gantt timeline
- `app/analytics/page.tsx` - Analytics dashboard
- `lib/supabase.ts` - Database client
- `lib/types.ts` - Type definitions

## Database
- **Supabase Project:** znueqcmlqfdhetnierno
- Tables: clients, games, products, platforms, sales, platform_events

## Pending Work (Issues #4-7)
- Duration input flexibility (text field vs slider)
- Timeline width resize by dragging
- Auto-generation of platform selections
- Edit platform colors directly

## Commands
```bash
npm run dev -- -p 3003    # Start local dev
npm run build             # Build for production
git push origin main      # Deploy to Vercel
```
