# GameDrive Development Workflow & Feedback Loops

## Overview

This document captures the development patterns and feedback loops that enable smooth, semi-autonomous development of the GameDrive Sales Planning Tool. These patterns allow Claude to work effectively with minimal back-and-forth while maintaining quality and catching issues early.

---

## Core Principle: Visual Verification is Truth

**Key Learning:** Technical deployment success ≠ Visual rendering success

The most critical feedback loop is visual verification. Deployments can report "success" while the actual rendered output is broken. Always close the loop with visual confirmation.

### The Verification Chain
```
Code Change → GitHub Commit → Vercel Build → Deploy Success → VISUAL CHECK ✓
                                                    ↓
                                              (This is where silent failures hide)
```

---

## Feedback Loop Patterns

### 1. Screenshot-Driven Development

**Pattern:** User provides screenshot → Claude identifies issues → Claude implements fix → User provides new screenshot

**Why it works:**
- Screenshots are unambiguous - no guessing about what's actually rendering
- Catches CSS issues that compile but don't display correctly
- Reveals UX problems that aren't apparent from code review
- Provides instant feedback on design changes

**Best Practice:**
- Always request screenshot after UI changes
- Compare before/after when making style updates
- Look for both the intended change AND unintended side effects

### 2. Optimistic UI with Server Validation

**Pattern:** Update UI instantly → Send to server → Rollback on error

```typescript
// Optimistic update pattern
const handleAction = async () => {
  // 1. Save current state for rollback
  const previousState = [...currentState]
  
  // 2. Update UI immediately
  setCurrentState(newState)
  
  // 3. Send to server
  try {
    await serverAction()
  } catch (error) {
    // 4. Rollback on failure
    setCurrentState(previousState)
    showError(error.message)
  }
}
```

**Why it works:**
- Users see instant response (perceived performance)
- Server remains source of truth
- Errors are recoverable without data loss
- No loading spinners blocking interaction

### 3. TypeScript as Early Warning System

**Pattern:** Type errors surface issues before deployment

**The Flow:**
```
Write Code → TypeScript Error → Fix Immediately → No Deployment Failure
```

**Key Types to Define:**
```typescript
// Always define interfaces for:
- Database row types (match Supabase schema exactly)
- Component props (catch missing props at compile time)
- API responses (validate data shapes)
- Form state (ensure all fields handled)
```

**Common Catches:**
- Missing required props on components
- Incorrect property names from database
- Nullable fields not handled
- Type mismatches between components

### 4. Incremental Deployment Testing

**Pattern:** Small commits → Verify each → Build on success

**Anti-pattern:** Large commits with multiple features → Hard to identify failure source

**Best Practice:**
```
Feature A (commit) → Deploy → Verify ✓
Feature B (commit) → Deploy → Verify ✓
Feature C (commit) → Deploy → Verify ✗ → Easy to isolate issue
```

### 5. CSS Module Isolation

**Pattern:** Each component owns its styles → No global CSS conflicts

**Why we chose CSS Modules over Tailwind:**
- Tailwind had silent compilation failures on Vercel
- CSS Modules always work if the file exists
- Styles are co-located with components
- No class name conflicts between components

**File Structure:**
```
ComponentName.tsx
ComponentName.module.css  ← Always paired
```

---

## Development Session Patterns

### Starting a Session

1. **Review Memory/Context**
   - Check what was accomplished in previous sessions
   - Identify any pending issues or blockers
   - Understand current project state

2. **Verify Live Site**
   - Check current deployment status
   - Confirm what's actually live vs. what's in code

3. **Establish Session Goals**
   - What features/fixes are we targeting?
   - What's the priority order?

### During Development

1. **Make atomic changes**
   - One feature or fix per commit
   - Clear commit messages describing the change

2. **Test after each change**
   - Wait for Vercel deployment (~2-3 minutes)
   - Verify the change worked as expected

3. **Document decisions**
   - Why was this approach chosen?
   - What alternatives were considered?

### Ending a Session

1. **Update progress tracker**
   - What was completed?
   - What's remaining?
   - Any blockers or issues?

2. **Leave clear next steps**
   - What should the next session focus on?
   - Any context needed for future work?

---

## Error Recovery Patterns

### Deployment Failures

**Symptom:** Vercel build fails

**Recovery:**
1. Check Vercel build logs for specific error
2. Most common: TypeScript compilation errors
3. Fix the specific error mentioned in logs
4. Re-commit and re-deploy

### Silent CSS Failures

**Symptom:** Deploy succeeds but UI looks wrong/broken

**Recovery:**
1. Check if CSS file is being imported
2. Verify class names match between TSX and CSS
3. Check for Tailwind vs CSS Module conflicts
4. Convert to CSS Modules if Tailwind is unreliable

### Database Constraint Errors

**Symptom:** API calls fail with constraint violations

**Recovery:**
1. Check Supabase logs for specific constraint
2. Common: Enum values not matching (sale_type, status)
3. Ensure frontend sends valid values
4. Update constraints if business logic changed

---

## MCP Integration Patterns

### GitHub MCP

**Reliable Parameters:**
```javascript
{
  owner: "joshmartin1186",
  repo: "Game-Drive-Sales-Planning",
  branch: "main"
}
```

**Best Practices:**
- Always include SHA when updating files (prevents conflicts)
- Use clear commit messages
- Commits auto-trigger Vercel deployments

### Supabase MCP

**Project ID:** `znueqcmlqfdhetnierno`
**Region:** `eu-west-1`

**Best Practices:**
- Use `apply_migration` for schema changes
- Use `execute_sql` for data queries
- Always test queries before applying migrations
- Keep RLS policies simple and testable

### Vercel MCP

**Team ID:** `team_Z5OC8EvDApJrhRy9CbCCaZPG`
**Project ID:** `prj_Mc1EoGbBPNWLyQ6Ah2SE91E9utGq`

**Best Practices:**
- Deployments are automatic from GitHub
- Build logs reveal TypeScript errors
- Check deployment status after commits

---

## Quality Checklist

### Before Committing
- [ ] TypeScript compiles without errors
- [ ] CSS classes exist in module file
- [ ] Props match component interface
- [ ] Database enums match frontend values

### After Deployment
- [ ] Page loads without errors
- [ ] Core functionality works
- [ ] Styles render correctly
- [ ] No console errors

### Before Ending Session
- [ ] Progress tracker updated
- [ ] Known issues documented
- [ ] Next steps identified

---

## Common Pitfalls & Solutions

| Pitfall | Solution |
|---------|----------|
| Tailwind classes not compiling | Use CSS Modules instead |
| Component missing prop | Check interface, add prop to parent |
| Database constraint error | Verify enum values match schema |
| Styles not applying | Check CSS Module import and class names |
| Deploy succeeds but broken | Request screenshot, don't trust status alone |
| Type errors after changes | Run through all component usages |

---

## Communication Patterns

### Asking for Feedback
```
"Can you share a screenshot of [specific page/component]?"
"Does the [feature] work as expected?"
"Any issues with [recent change]?"
```

### Reporting Progress
```
"Completed: [specific feature]"
"Deploying now - should be live in ~2 minutes"
"Found issue: [description]. Fixing..."
```

### Handling Issues
```
"Seeing [error]. Let me check [likely cause]..."
"The issue is [root cause]. Fixing by [solution]..."
"Fixed and redeploying. Please verify when live."
```

---

## Session Memory Template

For Claude Projects, maintain context with this structure:

```markdown
**Project:** GameDrive Sales Planning Tool
**Live URL:** https://platform.game-drive.nl/
**Repo:** GameDriveNL/Game-Drive-Sales-Planning
**Supabase:** znueqcmlqfdhetnierno

**Last Session:**
- Completed: [features]
- Issues: [any blockers]
- Next: [priorities]

**Proven Patterns:**
- CSS Modules for styling (not Tailwind)
- Optimistic UI updates
- TypeScript strict mode
- Screenshot verification

**Key Files:**
- app/page.tsx - Main dashboard
- app/components/GanttChart.tsx - Timeline view
- app/components/EditSaleModal.tsx - Edit form
- lib/types.ts - TypeScript interfaces
```

---

*This workflow enables effective semi-autonomous development with clear feedback loops at every stage.*
