# Putting CompassIQ online

This connects the code to your Supabase account (database and logins) and your Vercel account
(the website). It takes about 30 minutes, once.

**Keys:** never paste keys or passwords into chat, email or code. Keys only go into the Supabase
and Vercel settings screens described below.

## 1. Supabase: create the database

1. In Supabase, open your **compassiq** project. If you haven't created it yet, create one, pick a
   region close to your users (e.g. US East) and save the database password somewhere safe.
2. Go to **SQL Editor → New query**.
3. Open [`supabase/migrations/20261009000000_init.sql`](supabase/migrations/20261009000000_init.sql)
   on GitHub, copy all of it into the editor, and select **Run**. It should finish with "Success. No rows returned".

## 2. Supabase: login settings

Go to **Authentication**:

1. **Sign In / Providers → Email:** keep Email on, and turn **off** "Allow new users to sign up".
   Invites still work, but nobody can create their own account.
2. **URL Configuration:**
   - **Site URL:** your Vercel address from step 4, e.g. `https://compassiq.vercel.app`. You can
     come back and fill this in after step 4.
   - **Redirect URLs:** add `https://YOUR-ADDRESS/set-password`.
3. **Emails → SMTP Settings:** Supabase's built-in email sender only sends a few emails per hour,
   which is not enough to invite a team. Before inviting real clients, connect an email service
   such as Resend, Postmark or SendGrid here (they have free tiers). You can test without it, but
   the invites will slow down.

## 3. Supabase: copy the keys

Go to **Project Settings → API Keys** (on some projects, **Data API**). You need three values:

| Vercel setting | Where it is in Supabase |
|---|---|
| `SUPABASE_URL` | Project URL, e.g. `https://abcd1234.supabase.co` |
| `SUPABASE_ANON_KEY` | The **publishable** key (older projects call it **anon public**) |
| `SUPABASE_SERVICE_ROLE_KEY` | The **secret** key (older projects call it **service_role**). Treat it like a master password: it only goes into Vercel. |

## 4. Vercel: deploy the website

1. In Vercel, select **Add New → Project** and import the **compassiq** GitHub repository.
2. Leave the framework as detected ("Other"). `vercel.json` sets everything else.
3. Under **Environment Variables**, add the three values from step 3. Mark
   `SUPABASE_SERVICE_ROLE_KEY` as **Sensitive**.
4. Select **Deploy**. When it finishes, Vercel shows your address. Put it into Supabase's Site URL
   and Redirect URLs (step 2).

Vercel deploys every branch automatically. The `main` branch is your live site, and other branches
get preview addresses for testing.

## 5. Make yourself the CompassIQ team admin

1. In Supabase, go to **Authentication → Users → Add user → Create new user**. Enter your email
   and a strong password, and tick **Auto Confirm User**.
2. In **SQL Editor**, run this with your email:

   ```sql
   insert into public.platform_admins (user_id)
   select id from auth.users where email = 'you@example.com';
   ```

3. Open your Vercel address and sign in. You land on **Client companies**.

## 6. Add your first client

1. On **Client companies**, select **Add a company** and enter the company name and the owner's
   email and name. The owner gets an invite email and sets a password.
2. The owner signs in, which opens **Team & territories**:
   - **Load & publish doctor data** opens the admin tool. Load the doctor Excel file (plus trends
     and call activity if you have them), then select **Publish to reps**. Territories are created
     from the file's territory column.
   - **Invite someone** adds reps (one territory each), managers (the territories you pick) and
     admins.
3. Reps open the invite email, set a password, and sign in on their iPad. In Safari, use
   **Share → Add to Home Screen** for an app icon.

## Turning access off

- **One person:** on Team & territories, select **Turn off**.
- **A whole client company:** on Client companies, select **Suspend**.

Either way, the database stops returning their data immediately. Their app erases its local
CompassIQ data and shows "Your access is turned off" the next time it opens, or within five
minutes if it's already open. Select **Turn on** or **Reactivate** to restore access. The company's
data is kept.
