package io.github.pipo3355.anixartoffline;

import android.content.res.Configuration;
import android.os.Build;
import android.os.Bundle;
import android.view.Window;
import android.view.WindowManager;

import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;

import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebViewClient;
import com.getcapacitor.PluginHandle;

public class MainActivity extends BridgeActivity {

    /** Плеер открыт: строка состояния и навигация скрыты (выезжают только свайпом от края). */
    private boolean immersive = false;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // свой плагин нужно зарегистрировать до запуска моста
        registerPlugin(DevicePlugin.class);
        super.onCreate(savedInstanceState);
        // онлайн-просмотр: видео с CDN без CORS идёт через MediaProxy
        getBridge().setWebViewClient(new BridgeWebViewClient(getBridge()) {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                if (MediaProxy.handles(request.getUrl())) return MediaProxy.fetch(request);
                return super.shouldInterceptRequest(view, request);
            }
        });
    }

    /** Полноэкранный режим для плеера. Вызывать в UI-потоке. */
    public void setImmersive(boolean on) {
        immersive = on;
        Window w = getWindow();
        WindowInsetsControllerCompat c = WindowCompat.getInsetsController(w, w.getDecorView());
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            WindowManager.LayoutParams lp = w.getAttributes();
            // видео заходит под «чёлку» камеры, как в других плеерах
            lp.layoutInDisplayCutoutMode = on
                    ? WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
                    : WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_DEFAULT;
            w.setAttributes(lp);
        }
        if (on) {
            // без этого режима любое касание экрана возвращает строку состояния насовсем
            c.setSystemBarsBehavior(WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            c.hide(WindowInsetsCompat.Type.systemBars());
        } else {
            c.show(WindowInsetsCompat.Type.systemBars());
        }
    }

    // после шторки уведомлений, диалога, поворота система может вернуть панели — прячем снова
    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus && immersive) setImmersive(true);
    }

    @Override
    public void onConfigurationChanged(Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        if (immersive) setImmersive(true);
    }

    @Override
    public void onPictureInPictureModeChanged(boolean isInPictureInPictureMode, Configuration newConfig) {
        super.onPictureInPictureModeChanged(isInPictureInPictureMode, newConfig);
        PluginHandle handle = getBridge().getPlugin("Device");
        if (handle != null && handle.getInstance() instanceof DevicePlugin) {
            ((DevicePlugin) handle.getInstance()).onPipChanged(isInPictureInPictureMode);
        }
    }
}
