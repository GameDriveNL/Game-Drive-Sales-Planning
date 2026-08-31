-- Storage bucket for feedback ticket screenshots/attachments
insert into storage.buckets (id, name, public)
values ('feedback-images', 'feedback-images', true)
on conflict (id) do nothing;

-- Authenticated users (anyone logged into the app) can upload
create policy "Authenticated users can upload feedback images"
on storage.objects for insert
to authenticated
with check (bucket_id = 'feedback-images');

-- Authenticated users can delete their own uploads (item detail "remove image")
create policy "Authenticated users can delete feedback images"
on storage.objects for delete
to authenticated
using (bucket_id = 'feedback-images');

-- Column to store the uploaded image's public URL
alter table feedback_items add column if not exists image_url text;
