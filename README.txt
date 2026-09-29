WHOSE PAGE - TYPING FIX

This version fixes the writing-text bug:
- Realtime player updates no longer rerender the writing form.
- The writing textarea is initialized only once per round.
- Realtime room events during the same writing round do not restart the form/timer.
- Opening the site always starts at the name screen; old local sessions are not auto-rejoined.
- Exit clears the room UI and local state.
- The room bar is inside the main app container.

Keep your existing assets/bg.jpg and assets/avatars files if your project has them.

IMPORTANT:
The supplied avatars.js still contains the avatar list from the current uploaded project.
If you want the real SVG avatar folder wired into the picker, provide the SVG files/folder so their exact filenames can be used.

SUPABASE:
If you already ran the original schema, do NOT rerun it just to apply this update.
Use presence_migration.sql only for the player/room cleanup trigger changes.
