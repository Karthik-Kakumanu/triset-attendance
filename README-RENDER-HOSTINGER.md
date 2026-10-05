# Employee Attendance System — Render App + Hostinger MySQL

This version is intentionally simple:

- Application/server: Render Web Service (native Node.js; no Docker)
- Database: Hostinger MySQL
- One Render URL for employees/admin
- Server/database generated timestamps in IST (+05:30)
- Admin creates employee email/password accounts
- Employee: Check In → Start Break → Resume Work → Check Out
- Multiple breaks per work session
- Admin live dashboard and attendance history
- CSV export

## 1. Hostinger: create the MySQL database

In Hostinger hPanel:

Websites → Dashboard → Databases → MySQL Databases / Management

Create a database and database user. Save:

- Database name
- Database username
- Database password
- MySQL host shown by Hostinger

Default MySQL port: 3306.

## 2. Hostinger: allow Render to connect

In Hostinger hPanel:

Websites → Dashboard → Databases → Remote MySQL

Hostinger offers an `Any Host` option (`%`) for remote access. This is the easiest compatibility option with Render because Render services use outbound IP ranges. For a small internal deployment, use a very strong MySQL password and only expose this one database/user. If Hostinger lets you enter the complete Render outbound CIDR ranges, use those instead of Any Host.

Hostinger documentation:
https://www.hostinger.com/support/1583546-how-to-set-up-remote-mysql-access-in-hostinger/

Render outbound IP documentation:
https://render.com/docs/outbound-ip-addresses

## 3. Put this project on GitHub

Create a private GitHub repository and upload every file in this folder.

Do NOT upload a `.env` file or real passwords.

## 4. Render: create the application

Render Dashboard → New → Web Service → choose your GitHub repository.

Use:

- Name: `company-employee-attendance`
- Region: Singapore (closest Render region to India among current choices)
- Branch: `main`
- Language: Node
- Build command: `npm install`
- Start command: `npm start`
- Health check path: `/health`

Render provides each web service a unique `onrender.com` URL.

Free testing is possible, but Render free web services spin down after 15 minutes without traffic. For a company attendance system where employees use it throughout the day, a paid web-service instance avoids those cold starts.

## 5. Render environment variables

In Render → your service → Environment, create these variables:

DB_HOST=Hostinger's MySQL host
DB_PORT=3306
DB_NAME=Hostinger database name
DB_USER=Hostinger database username
DB_PASSWORD=Hostinger database password
DB_SSL=false
PORT=10000
APP_TIMEZONE=Asia/Kolkata
COOKIE_NAME=attendance_session
SESSION_IDLE_TIMEOUT_MINUTES=720
JWT_SECRET=long-random-secret
ADMIN_NAME=Company Administrator
ADMIN_EMAIL=your-admin-email
ADMIN_PASSWORD=your-strong-admin-password
NODE_ENV=production

Do not paste a real password into GitHub. Use Render Environment Variables.

## 6. Deploy

Click Create Web Service / Deploy.

The first boot automatically creates the tables from `database/schema.sql` and creates the first admin account from ADMIN_NAME / ADMIN_EMAIL / ADMIN_PASSWORD if no admin exists.

## 7. Open the Render URL

Render will give you something like:

https://company-employee-attendance.onrender.com

Open that URL. Log in as the admin.

## 8. Create employees

Admin → Employees → Add employee.

Enter:

- Employee code
- Name
- Email
- Password (minimum 8 chars)
- Designation
- Department
- Phone

Employees use the same Render URL with the email/password created by the admin.

## 9. Attendance flow

Employee:

1. Login
2. Check In
3. Start Break
4. Resume Work
5. Repeat break as needed
6. Check Out

Check-out is blocked while a break is active.

## 10. Timing accuracy

Attendance actions use MySQL `NOW()` after setting the MySQL session timezone to `+05:30`. The browser's clock is not used to create the attendance timestamp.

This is timekeeping logic, not a legal payroll/compliance certification. For payroll use, add correction approvals, audit review, backups, and your local employment-policy rules.

## 11. Admin reports

Admin → Attendance & Reports.

Choose From / To dates, load records, and export CSV.

## 12. Backups

Because the database is on Hostinger, configure regular Hostinger database backups before using the system as the company's official attendance record. Keep an additional off-site backup for important records.
