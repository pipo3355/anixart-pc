package io.github.pipo3355.anixartoffline;

import android.content.res.Configuration;
import android.os.Build;
import android.os.Bundle;
import android.graphics.Color;
import android.graphics.drawable.Drawable;
import android.view.View;
import android.view.Window;

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
    private Drawable savedBackground = null;

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
        // Под вырез камеры окно не заводим: Capacitor отодвигает страницу от выреза отступом,
        // и там оставалась серая полоса фона окна. Без захода система сама закрашивает вырез чёрным.
        // Фон окна на время плеера тоже чёрный — чтобы никакие отступы не были видны.
        View decor = w.getDecorView();
        if (on) {
            if (savedBackground == null) savedBackground = decor.getBackground();
            decor.setBackgroundColor(Color.BLACK);
        } else if (savedBackground != null) {
            decor.setBackground(savedBackground);
            savedBackground = null;
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
