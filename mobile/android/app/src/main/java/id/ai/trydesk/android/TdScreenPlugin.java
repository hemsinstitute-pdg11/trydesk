package id.ai.trydesk.android;

import android.app.Activity;
import android.content.pm.ActivityInfo;
import android.content.pm.PackageManager;
import android.os.Build;
import com.getcapacitor.JSObject;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

// Full screen while a remote PC is on screen: Android's status and navigation bars hidden (a swipe from the edge
// shows them for a moment) and the phone held in landscape, so the PC picture fills the display. Called from
// mobile.js with { immersive, orientation: "landscape" | "auto" }; both are undone when the session ends.
@CapacitorPlugin(name = "TdScreen")
public class TdScreenPlugin extends Plugin {
    // Whether "lock to landscape" can work here. Google Play Games on a PC, ChromeOS and desktop-style Android run the
    // app in a window that never turns: asking for landscape there squeezed the page into the top third of the
    // portrait window (owner reports 2 and 17 Nov 2026). A split-screen window can't turn either.
    @PluginMethod
    public void info(PluginCall call) {
        final Activity activity = getActivity();
        final PackageManager pm = activity.getPackageManager();
        final boolean pcWindow = pm.hasSystemFeature("com.google.android.play.feature.HPE_EXPERIENCE")
            || pm.hasSystemFeature("android.hardware.type.pc")
            || pm.hasSystemFeature("org.chromium.arc");
        final boolean split = Build.VERSION.SDK_INT >= 24 && activity.isInMultiWindowMode();
        JSObject out = new JSObject();
        out.put("canRotate", !pcWindow && !split);
        out.put("pcWindow", pcWindow);
        call.resolve(out);
    }

    @PluginMethod
    public void set(PluginCall call) {
        final boolean immersive = Boolean.TRUE.equals(call.getBoolean("immersive", false));
        final boolean landscape = "landscape".equals(call.getString("orientation", "auto"));
        final Activity activity = getActivity();
        activity.runOnUiThread(() -> {
            WindowInsetsControllerCompat bars = WindowCompat.getInsetsController(activity.getWindow(), activity.getWindow().getDecorView());
            if (immersive) {
                bars.setSystemBarsBehavior(WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
                bars.hide(WindowInsetsCompat.Type.systemBars());
            } else {
                bars.show(WindowInsetsCompat.Type.systemBars());
            }
            activity.setRequestedOrientation(landscape ? ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE : ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED);
            call.resolve();
        });
    }
}
