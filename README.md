# Scriptroom

A screenplay archive designed for GitHub Pages. Visitors can browse and read screenplay PDFs. Only user accounts explicitly listed in the Supabase `admins` table can upload, edit or delete content.

## What is included

- Responsive screenplay-library interface with dark mode and a light-mode option.
- Search by title, genre, year or description; filter by genre; sort the collection.
- PDF upload form with title, genre, optional year and a short note.
- In-page PDF reader plus an option to open the original PDF in a new tab.
- Admin sign-in, upload and delete controls.
- Supabase Row Level Security (RLS) policies. Permission checks happen in the database and Storage, not only in the browser.
- No build step. The static site can be published directly from a GitHub repository.

## Important: how hosting and storage work

GitHub Pages only serves the website's static files. It is not a database and cannot securely receive uploads. Scriptroom uses:

- **GitHub Pages** for the website interface.
- **Supabase Auth** for administrator sign-in.
- **Supabase Database** for screenplay titles and metadata.
- **Supabase Storage** for the actual PDF files.

The browser-visible Supabase publishable/anon key is expected to be public. The database and Storage RLS policies in `supabase-setup.sql` enforce who can write. **Never put a Supabase `service_role` or secret key in `config.js` or any file deployed to GitHub.**

## 1. Create the Supabase project

1. Open [supabase.com](https://supabase.com/) and create a project.
2. Choose a project name and a strong database password. Save that password somewhere safe.
3. When the project is ready, open **SQL Editor**.
4. Choose **New query**, paste all of `supabase-setup.sql`, and run it.
5. Open **Project Settings → API** (the API Keys section in the dashboard). Copy the **Project URL** and the browser-safe **publishable key**. A legacy `anon` key is also accepted. Do not copy the `service_role` or secret key.

The SQL creates the database tables, a Storage bucket named `screenplays`, and the permission policies. The bucket is public-read so visitors can read the PDFs, but the policies only allow administrator accounts to upload or delete files.

## 2. Create your administrator account

1. In Supabase, open **Authentication → Users**.
2. Add a user with your email address and a strong password. Confirm/create the user in the dashboard.
3. Copy your user's UUID from the Users table.
4. Open **SQL Editor** and run this, replacing the example email with your account email:

```sql
insert into public.admins (user_id)
select id
from auth.users
where email = 'you@example.com'
on conflict (user_id) do nothing;
```

5. In **Authentication → Settings** (sometimes shown under **Sign In / Providers** or **User Signups**), disable new user sign-ups. You are creating the admin account yourself, so visitors do not need accounts.

Only user IDs in `public.admins` are administrators. Creating another Auth user does not automatically grant upload access.

## 3. Connect Scriptroom to Supabase

Open `config.js` and replace the two placeholders:

```js
window.SCRIPTROOM_CONFIG = {
  SUPABASE_URL: "https://YOUR_PROJECT_ID.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_..."
};
```

Use your actual Project URL and publishable key. If your dashboard only displays a legacy `anon` key, you may paste that instead. Keep the quotes.

## 4. Test it on your computer

The easiest method is Visual Studio Code with the **Live Server** extension:

1. Open the `scriptroom-site` folder in VS Code.
2. Right-click `index.html` and choose **Open with Live Server**.
3. Visit the local address it opens.
4. Click **Admin sign in**, enter your Supabase admin email/password, and upload a small PDF.
5. Open the site in a private/incognito browser window. You should be able to see and read the PDF, but there should be no upload button or admin controls.

You can also use another simple static local web server. Avoid opening the HTML as a `file://` URL if your browser blocks module imports.

## 5. Publish with GitHub Pages

1. Create a GitHub repository, for example `scriptroom`.
2. Upload all files from this folder to the repository's root: `index.html`, `styles.css`, `app.js`, `config.js`, `supabase-setup.sql`, and this README.
3. Commit and push the files.
4. In the repository, open **Settings → Pages**.
5. Under **Build and deployment**, choose **Deploy from a branch**.
6. Select the `main` branch and `/ (root)` folder, then save.
7. Wait for GitHub Pages to publish the site. Its URL will look like `https://YOUR_USERNAME.github.io/scriptroom/`.

Because this project uses relative file paths, it works on a GitHub Pages project URL as well as a root GitHub Pages URL. After every code or design change, commit and push again.

## 6. How to use the library

- Visitors can search, filter, sort, and open a screenplay card to read its PDF.
- Sign in using the administrator account to reveal **Upload screenplay**.
- Add a title, choose a genre, optionally add a year and a short note, then select a PDF.
- The upload limit is 50 MB. The bucket also enforces the same 50 MB limit.
- The administrator can remove an item with the small trash icon on its card.
- The moon/sun button switches between dark and light mode. The preference is saved in that browser.

## Privacy and access notes

- **Anyone can view the library and its PDFs.** This matches a public reading archive.
- The PDF bucket is public-read. Anyone who gets a PDF's URL can open it, and a viewer can save or capture the document. A browser PDF viewer cannot guarantee view-only access or prevent screenshots.
- **Only administrators can upload, update or delete** because those operations are restricted by Supabase RLS policies. Hiding the upload button is only a user-interface convenience; the database and Storage policies provide the real protection.
- Do not upload scripts, drafts or personal documents that must remain confidential. For a genuinely private archive, use a private Storage bucket and authenticated reader access instead.
- GitHub repositories can expose `config.js` to anyone who can view the repository. That is fine for a publishable/anon key when RLS is correctly configured. Never commit passwords, service-role keys, or secret API keys.

## Troubleshooting

**The page says “Setup required”**

Check that `config.js` contains the correct Project URL and publishable/anon key and that you saved the file.

**The page says “Couldn't open the archive”**

Run `supabase-setup.sql` in the Supabase SQL Editor. Check that the `screenplays` table exists and its SELECT policy is enabled.

**Sign-in works but upload controls do not appear**

Make sure the signed-in email's user ID is present in `public.admins`. Use the `insert into public.admins ... select id from auth.users ...` statement above.

**Upload fails with a permission or RLS error**

Check that the user is in `public.admins`, that the Storage policies were created, and that the bucket is named exactly `screenplays`.

**The PDF does not appear inside the reader**

Try the **Open PDF** link. Some browser extensions or embedded-PDF settings can interfere with iframe PDF viewing. The PDF itself is still stored in Supabase Storage.

**The page looks unstyled or JavaScript does not load**

Check that `styles.css`, `config.js`, and `app.js` are in the same repository folder as `index.html`, with the exact filenames shown here.
