package id.ai.trydesk.android;

import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(TdScreenPlugin.class);   // full screen + landscape during a session (mobile.js)
        registerPlugin(TdLanPlugin.class);      // connect by IP on the same network (mobile-shim.js lan*)
        registerPlugin(TdFilePlugin.class);     // screenshots and recordings into the gallery (mobile-shim.js file*)
        registerPlugin(TdUpdatePlugin.class);   // in-app updates: verified APK to Android's installer (mobile-shim.js update*)
        // Debug builds only: a local update test server and its throwaway key (TdUpdatePlugin). Release ignores it.
        if ((getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0) {
            Intent i = getIntent();
            String u = i != null ? i.getStringExtra("tdUpdateUrl") : null, k = i != null ? i.getStringExtra("tdUpdateKey") : null;
            if (u != null && k != null && k.matches("^[A-Za-z0-9+/=]{40,80}$")) { TdUpdatePlugin.testUrl = u; TdUpdatePlugin.testKey = k; }
        }
        super.onCreate(savedInstanceState);
    }
}
