package id.ai.trydesk.android;

import android.content.Context;
import android.content.Intent;
import android.os.UserManager;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import androidx.activity.result.ActivityResult;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.regex.Pattern;
import org.json.JSONObject;

// In-app updates on the phone (owner 18 Nov 2026, direction A; the desktop has src/updater.js). The APK comes from
// trydesk.ai.id/downloads/ only, and is kept only when its size and SHA-256 equal the signed download list that
// mobile-shim.js has already checked (Ed25519, the same key and bytes as the desktop). Android itself then asks
// "update this app?" (FileProvider + REQUEST_INSTALL_PACKAGES; the first time it shows "install from this source"),
// and refuses any APK signed with another key. The file waits in the app's own files folder (update/), re-checked
// right before it is handed over.
//
// Debug builds only: MainActivity may pass a local test server (adb shell am start ... --es tdUpdateUrl
// http://127.0.0.1:<port>/update/version.json --es tdUpdateKey <throwaway public key>); release builds ignore it.
@CapacitorPlugin(name = "TdUpdate")
public class TdUpdatePlugin extends Plugin {
    static volatile String testUrl = "", testKey = "";
    private static final String SITE = "https://trydesk.ai.id/downloads/";
    private static final Pattern PATH_RE = Pattern.compile("^android/TryDesk-[A-Za-z0-9._-]{1,80}\\.apk$");
    private static final Pattern SHA_RE = Pattern.compile("^[0-9a-f]{64}$");
    private static final Pattern VER_RE = Pattern.compile("^\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}$");
    private static final Pattern TEST_RE = Pattern.compile("^http://(127\\.0\\.0\\.1|localhost):\\d{2,5}/[\\w./-]*$");
    private static final long MAX_SIZE = 400L * 1024 * 1024;

    private volatile boolean running = false, stop = false;
    private volatile HttpURLConnection conn;
    private long lastEmit = 0;

    // Set only by MainActivity, and only in a debuggable build.
    static boolean testOn() { return TEST_RE.matcher(testUrl).matches() && !testKey.isEmpty(); }

    private File dir() { File d = new File(getContext().getFilesDir(), "update"); //noinspection ResultOfMethodCallIgnored
        d.mkdirs(); return d; }
    private File readyFile() { return new File(dir(), "ready.json"); }

    private long myVersionCode() {
        try {
            PackageInfo p = getContext().getPackageManager().getPackageInfo(getContext().getPackageName(), 0);
            return Build.VERSION.SDK_INT >= 28 ? p.getLongVersionCode() : p.versionCode;
        } catch (Exception e) { return Long.MAX_VALUE; }
    }
    private String myVersion() {
        try { return getContext().getPackageManager().getPackageInfo(getContext().getPackageName(), 0).versionName; }
        catch (Exception e) { return ""; }
    }
    private boolean canInstall() {
        return Build.VERSION.SDK_INT < 26 || getContext().getPackageManager().canRequestPackageInstalls();
    }
    // A device rule forbids every app from installing APKs (found 18 Nov 2026 on Google Play Games for PC: the
    // "allow from this source" switch is locked). The page then keeps the website link instead of a dead end.
    private boolean installBlocked() {
        try {
            UserManager um = (UserManager) getContext().getSystemService(Context.USER_SERVICE);
            if (um == null) return false;
            if (um.hasUserRestriction(UserManager.DISALLOW_INSTALL_UNKNOWN_SOURCES)) return true;
            return Build.VERSION.SDK_INT >= 29 && um.hasUserRestriction(UserManager.DISALLOW_INSTALL_UNKNOWN_SOURCES_GLOBALLY);
        } catch (Exception e) { return false; }
    }

    // What JS needs at start: the test server (debug), this app's version, and a verified file waiting from before.
    @PluginMethod
    public void info(PluginCall call) {
        JSObject r = new JSObject();
        r.put("test", testOn());
        r.put("testUrl", testOn() ? testUrl : "");
        r.put("testKey", testOn() ? testKey : "");
        r.put("version", myVersion());
        r.put("canInstall", canInstall());
        r.put("blocked", installBlocked());
        JSObject ready = readReady();
        if (ready != null) r.put("ready", ready);
        call.resolve(r);
    }

    // Debug test only: the test server's version.json read natively (the page's https origin may not fetch plain
    // http). The real app reads https://trydesk.ai.id/update/version.json in mobile-shim.js as before.
    @PluginMethod
    public void testVersionJson(PluginCall call) {
        if (!testOn()) { call.reject("no test server"); return; }
        new Thread(() -> {
            try {
                HttpURLConnection c = (HttpURLConnection) new URL(testUrl).openConnection();
                c.setConnectTimeout(8000); c.setReadTimeout(8000); c.setUseCaches(false);
                if (c.getResponseCode() != 200) throw new Exception("HTTP " + c.getResponseCode());
                java.io.ByteArrayOutputStream s = new java.io.ByteArrayOutputStream();
                try (InputStream in = c.getInputStream()) { byte[] b = new byte[8192]; int n; while ((n = in.read(b)) > 0 && s.size() < 65536) s.write(b, 0, n); }
                c.disconnect();
                JSObject r = new JSObject(); r.put("text", new String(s.toByteArray(), StandardCharsets.UTF_8)); call.resolve(r);
            } catch (Exception e) { call.reject("test server not reached"); }
        }, "td-update-test").start();
    }

    private JSObject readReady() {
        try {
            File f = readyFile();
            if (!f.isFile()) return null;
            byte[] b = new byte[(int) Math.min(f.length(), 4096)];
            try (InputStream in = new FileInputStream(f)) { int n = in.read(b); if (n <= 0) return null; b = java.util.Arrays.copyOf(b, n); }
            JSONObject j = new JSONObject(new String(b, StandardCharsets.UTF_8));
            File apk = new File(dir(), j.optString("name", "-"));
            if (!apk.isFile() || apk.length() != j.optLong("size", -1)) return null;
            JSObject o = new JSObject();
            o.put("version", j.optString("version", ""));
            o.put("sha256", j.optString("sha256", ""));
            o.put("size", j.optLong("size", 0));
            return o;
        } catch (Exception e) { return null; }
    }

    // Fetches the APK named by the (already verified) signed list. Resolves { ok } or { ok: false, error: "sig" | "net"
    // | "paused" | "busy" | "bad" }; progress goes out as "progress" events.
    @PluginMethod
    public void download(PluginCall call) {
        final String path = call.getString("path", ""), sha = call.getString("sha256", ""), ver = call.getString("version", "");
        // optLong: the bridge hands a JS number over as an Integer below 2^31 (getLong() then gives null).
        final long size = call.getData().optLong("size", -1);
        if (!PATH_RE.matcher(path).matches() || !SHA_RE.matcher(sha).matches() || !VER_RE.matcher(ver).matches() || size < 1 || size > MAX_SIZE) { fail(call, "bad"); return; }
        synchronized (this) { if (running) { fail(call, "busy"); return; } running = true; stop = false; }
        call.setKeepAlive(true);
        new Thread(() -> {
            try { fetch(call, path, sha, ver, size, false); }
            finally { synchronized (this) { running = false; } call.setKeepAlive(false); }
        }, "td-update").start();
    }

    private String baseUrl() throws Exception {
        if (testOn()) return new URL(new URL(testUrl), "/downloads/").toString();
        return SITE;
    }

    private void fetch(PluginCall call, String path, String sha, String ver, long size, boolean retried) {
        File d = dir();
        File part = new File(d, "download.part"), partFor = new File(d, "download.for");
        long have = 0;
        MessageDigest md;
        try { md = MessageDigest.getInstance("SHA-256"); } catch (Exception e) { fail(call, "net"); return; }
        // A paused download of the same file resumes where it stopped.
        try {
            if (part.isFile() && sha.equals(readSmall(partFor)) && part.length() > 0 && part.length() < size) {
                try (InputStream in = new FileInputStream(part)) { byte[] b = new byte[64 * 1024]; int n; while ((n = in.read(b)) > 0) md.update(b, 0, n); }
                have = part.length();
            } else { //noinspection ResultOfMethodCallIgnored
                part.delete(); }
            writeSmall(partFor, sha);
        } catch (Exception e) { //noinspection ResultOfMethodCallIgnored
            part.delete(); have = 0; md.reset(); }

        long received = have;
        try {
            String base = baseUrl();
            URL url = new URL(base + path);
            String host = url.getHost();
            boolean allowed = testOn() ? ("127.0.0.1".equals(host) || "localhost".equals(host)) : ("https".equals(url.getProtocol()) && "trydesk.ai.id".equals(host));
            if (!allowed) { fail(call, "bad"); return; }
            HttpURLConnection c = (HttpURLConnection) url.openConnection();
            conn = c;
            c.setConnectTimeout(15000); c.setReadTimeout(30000);
            c.setUseCaches(false);
            c.setRequestProperty("Cache-Control", "no-cache");
            if (have > 0) c.setRequestProperty("Range", "bytes=" + have + "-");
            int code = c.getResponseCode();
            if (have > 0 && code != 206) { have = 0; received = 0; md.reset(); }
            if (code < 200 || code >= 300) throw new Exception("HTTP " + code);
            // A redirect may not leave the allowed site.
            String endHost = c.getURL().getHost();
            if (!(testOn() ? ("127.0.0.1".equals(endHost) || "localhost".equals(endHost)) : "trydesk.ai.id".equals(endHost))) { c.disconnect(); fail(call, "bad"); return; }
            emit(received, size, true);
            try (InputStream in = c.getInputStream(); OutputStream out = new FileOutputStream(part, have > 0)) {
                byte[] b = new byte[64 * 1024];
                int n;
                while ((n = in.read(b)) > 0) {
                    if (stop) throw new InterruptedException();
                    received += n;
                    if (received > size) throw new SecurityException("larger than the signed size");
                    md.update(b, 0, n);
                    out.write(b, 0, n);
                    emit(received, size, false);
                }
            }
            c.disconnect();
            String sum = hex(md.digest());
            if (received != size || !sum.equals(sha)) {
                //noinspection ResultOfMethodCallIgnored
                part.delete(); //noinspection ResultOfMethodCallIgnored
                partFor.delete();
                // A resumed file can be damaged by the break itself: one fresh try before calling it a mismatch.
                if (have > 0 && !retried) { fetch(call, path, sha, ver, size, true); return; }
                fail(call, "sig");
                return;
            }
            File apk = new File(d, path.substring(path.lastIndexOf('/') + 1));
            //noinspection ResultOfMethodCallIgnored
            apk.delete();
            if (!part.renameTo(apk)) throw new Exception("rename failed");
            //noinspection ResultOfMethodCallIgnored
            partFor.delete();
            if (!samePackageNewer(apk)) { //noinspection ResultOfMethodCallIgnored
                apk.delete(); fail(call, "sig"); return; }
            // Only the newest verified file stays.
            File[] all = d.listFiles();
            if (all != null) for (File f : all) if (f.getName().endsWith(".apk") && !f.equals(apk)) { //noinspection ResultOfMethodCallIgnored
                f.delete(); }
            JSONObject j = new JSONObject();
            j.put("version", ver); j.put("sha256", sha); j.put("size", size); j.put("name", apk.getName());
            writeSmall(readyFile(), j.toString());
            JSObject r = new JSObject(); r.put("ok", true); r.put("version", ver);
            call.resolve(r);
        } catch (InterruptedException e) {
            fail(call, "paused");
        } catch (SecurityException e) {
            //noinspection ResultOfMethodCallIgnored
            part.delete(); //noinspection ResultOfMethodCallIgnored
            partFor.delete();
            fail(call, "sig");
        } catch (Exception e) {
            fail(call, stop ? "paused" : "net");
        } finally { conn = null; }
    }

    // The APK is this app (same package name) and newer than what runs now. Android checks the signing key itself.
    private boolean samePackageNewer(File apk) {
        try {
            PackageInfo p = getContext().getPackageManager().getPackageArchiveInfo(apk.getAbsolutePath(), 0);
            if (p == null || !getContext().getPackageName().equals(p.packageName)) return false;
            long vc = Build.VERSION.SDK_INT >= 28 ? p.getLongVersionCode() : p.versionCode;
            return vc > myVersionCode();
        } catch (Exception e) { return false; }
    }

    private void emit(long received, long total, boolean force) {
        long now = System.currentTimeMillis();
        if (!force && now - lastEmit < 250 && received < total) return;
        lastEmit = now;
        JSObject o = new JSObject(); o.put("received", received); o.put("total", total);
        notifyListeners("progress", o);
    }

    @PluginMethod
    public void pause(PluginCall call) {
        stop = true;
        HttpURLConnection c = conn;
        if (c != null) new Thread(() -> { try { c.disconnect(); } catch (Exception ignored) {} }).start();
        call.resolve();
    }

    // Removes every update file (a newer list replaced it, or the update is installed).
    @PluginMethod
    public void drop(PluginCall call) {
        if (running) { stop = true; }
        File[] all = dir().listFiles();
        if (all != null) for (File f : all) { //noinspection ResultOfMethodCallIgnored
            f.delete(); }
        call.resolve();
    }

    // Hands the verified APK to Android's installer. The first time, Android's "install unknown apps" switch for
    // TryDesk opens first; back from there the installer opens when the switch is on. Resolves { ok } or
    // { ok: false, error: "sig" (file changed or missing) | "permission" (switch left off) | "install" }.
    @PluginMethod
    public void install(PluginCall call) {
        if (installBlocked()) { fail(call, "blocked"); return; }
        File apk = checkedReady();
        if (apk == null) { fail(call, "sig"); return; }
        if (!canInstall()) {
            try {
                Intent i = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + getContext().getPackageName()));
                startActivityForResult(call, i, "afterPermission");
            } catch (Exception e) { fail(call, "permission"); }
            return;
        }
        openInstaller(call, apk);
    }

    @ActivityCallback
    private void afterPermission(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (!canInstall()) { fail(call, "permission"); return; }
        File apk = checkedReady();
        if (apk == null) { fail(call, "sig"); return; }
        openInstaller(call, apk);
    }

    private void openInstaller(PluginCall call, File apk) {
        try {
            Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", apk);
            Intent i = new Intent(Intent.ACTION_VIEW);
            i.setDataAndType(uri, "application/vnd.android.package-archive");
            i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            getActivity().startActivity(i);
            JSObject r = new JSObject(); r.put("ok", true); call.resolve(r);
        } catch (Exception e) { fail(call, "install"); }
    }

    // The waiting file, hashed again right before it is handed over (it sat in storage since it was checked).
    private File checkedReady() {
        try {
            JSONObject j = new JSONObject(readSmall(readyFile()));
            File apk = new File(dir(), j.optString("name", "-"));
            if (!apk.isFile() || apk.length() != j.optLong("size", -1)) return null;
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            try (InputStream in = new FileInputStream(apk)) { byte[] b = new byte[64 * 1024]; int n; while ((n = in.read(b)) > 0) md.update(b, 0, n); }
            if (!hex(md.digest()).equals(j.optString("sha256", "")) || !samePackageNewer(apk)) {
                //noinspection ResultOfMethodCallIgnored
                apk.delete(); //noinspection ResultOfMethodCallIgnored
                readyFile().delete();
                return null;
            }
            return apk;
        } catch (Exception e) { return null; }
    }

    private static void fail(PluginCall call, String error) {
        JSObject r = new JSObject(); r.put("ok", false); r.put("error", error); call.resolve(r);
    }
    private static String hex(byte[] b) {
        StringBuilder s = new StringBuilder(b.length * 2);
        for (byte x : b) s.append(String.format("%02x", x));
        return s.toString();
    }
    private static String readSmall(File f) {
        try (InputStream in = new FileInputStream(f)) {
            byte[] b = new byte[4096]; int n = in.read(b);
            return n > 0 ? new String(b, 0, n, StandardCharsets.UTF_8) : "";
        } catch (Exception e) { return ""; }
    }
    private static void writeSmall(File f, String s) throws Exception {
        try (OutputStream out = new FileOutputStream(f)) { out.write(s.getBytes(StandardCharsets.UTF_8)); }
    }
}
