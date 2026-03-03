<?php
/**
 * Plugin Name: WP Admin Copilot
 * Description: Admin-only AI Copilot for indexed content retrieval via Smart Search MCP.
 * Version: 1.0.0
 * Author: WP Copilot
 */

if (!defined('ABSPATH')) {
    exit;
}

final class WP_Admin_Copilot {
    private const MENU_SLUG = 'wp-admin-copilot';
    private const OPT_ENDPOINT = 'wp_admin_copilot_agent_endpoint';
    private const OPT_SECRET = 'wp_admin_copilot_shared_secret';

    public static function init(): void {
        add_action('admin_menu', [self::class, 'register_menu']);
        add_action('admin_init', [self::class, 'register_settings']);
        add_action('admin_enqueue_scripts', [self::class, 'enqueue_assets']);
        add_action('admin_footer', [self::class, 'render_floating_widget']);
    }

    public static function register_menu(): void {
        add_menu_page(
            'WP Copilot',
            'WP Copilot',
            'edit_posts',
            self::MENU_SLUG,
            [self::class, 'render_admin_page'],
            'dashicons-format-chat',
            58
        );
    }

    public static function register_settings(): void {
        register_setting('wp_admin_copilot_settings_group', self::OPT_ENDPOINT, [
            'type' => 'string',
            'sanitize_callback' => 'esc_url_raw',
            'default' => '',
        ]);

        register_setting('wp_admin_copilot_settings_group', self::OPT_SECRET, [
            'type' => 'string',
            'sanitize_callback' => 'sanitize_text_field',
            'default' => '',
        ]);

        add_settings_section(
            'wp_admin_copilot_main_section',
            'Copilot Settings',
            function (): void {
                echo '<p>Configure the Next.js agent endpoint and shared token for secure requests.</p>';
            },
            self::MENU_SLUG
        );

        add_settings_field(
            self::OPT_ENDPOINT,
            'Agent Endpoint URL',
            [self::class, 'render_endpoint_field'],
            self::MENU_SLUG,
            'wp_admin_copilot_main_section'
        );

        add_settings_field(
            self::OPT_SECRET,
            'Shared Secret Token',
            [self::class, 'render_secret_field'],
            self::MENU_SLUG,
            'wp_admin_copilot_main_section'
        );
    }

    public static function render_endpoint_field(): void {
        $value = get_option(self::OPT_ENDPOINT, '');
        echo '<input type="url" class="regular-text" name="' . esc_attr(self::OPT_ENDPOINT) . '" value="' . esc_attr($value) . '" placeholder="https://your-nextjs-site.com/api/chat" />';
    }

    public static function render_secret_field(): void {
        $value = get_option(self::OPT_SECRET, '');
        echo '<input type="password" class="regular-text" name="' . esc_attr(self::OPT_SECRET) . '" value="' . esc_attr($value) . '" autocomplete="off" />';
    }

    public static function enqueue_assets(string $hook): void {
        unset($hook);
        if (!current_user_can('edit_posts')) {
            return;
        }

        wp_enqueue_script(
            'wp-admin-copilot-js',
            plugin_dir_url(__FILE__) . 'copilot.js',
            [],
            '1.0.0',
            true
        );

        wp_localize_script('wp-admin-copilot-js', 'WPAdminCopilotConfig', [
            'endpoint' => get_option(self::OPT_ENDPOINT, ''),
            'token' => get_option(self::OPT_SECRET, ''),
        ]);
    }

    public static function render_admin_page(): void {
        if (!current_user_can('edit_posts')) {
            wp_die('You do not have permission to access this page.');
        }
        ?>
        <div class="wrap">
            <h1>WP Copilot</h1>

            <form method="post" action="options.php" style="margin-bottom: 24px;">
                <?php
                settings_fields('wp_admin_copilot_settings_group');
                do_settings_sections(self::MENU_SLUG);
                submit_button('Save Settings');
                ?>
            </form>
            <p>The floating WP Copilot is available on all WP Admin pages for users who can edit posts.</p>
        </div>
        <?php
    }

    public static function render_floating_widget(): void {
        if (!is_admin() || !current_user_can('edit_posts')) {
            return;
        }
        ?>
        <div id="wp-admin-copilot-fab-wrap">
            <button id="wp-admin-copilot-fab" type="button" aria-expanded="false" aria-controls="wp-admin-copilot-panel">WP Copilot</button>
            <section id="wp-admin-copilot-panel" aria-hidden="true">
                <header>
                    <strong>WP Copilot</strong>
                    <div>
                        <button id="wp-admin-copilot-clear" type="button">Clear</button>
                        <button id="wp-admin-copilot-close" type="button" aria-label="Close copilot">X</button>
                    </div>
                </header>
                <div id="wp-admin-copilot-log"></div>
                <div id="wp-admin-copilot-controls">
                    <input id="wp-admin-copilot-input" type="text" placeholder="Ask about indexed content..." />
                    <button id="wp-admin-copilot-send" type="button">Send</button>
                </div>
                <p id="wp-admin-copilot-status"></p>
            </section>
        </div>
        <style>
            #wp-admin-copilot-fab-wrap {
                position: fixed;
                right: 16px;
                bottom: 16px;
                z-index: 99999;
            }
            #wp-admin-copilot-fab {
                border: none;
                border-radius: 999px;
                background: #1d2327;
                color: #fff;
                font-weight: 600;
                padding: 10px 14px;
                cursor: pointer;
                box-shadow: 0 6px 16px rgba(0,0,0,0.25);
            }
            #wp-admin-copilot-panel {
                position: absolute;
                right: 0;
                bottom: 52px;
                width: 360px;
                max-width: calc(100vw - 32px);
                height: 500px;
                max-height: calc(100vh - 90px);
                background: #fff;
                border: 1px solid #dcdcde;
                border-radius: 10px;
                box-shadow: 0 14px 32px rgba(0,0,0,0.25);
                display: none;
                overflow: hidden;
            }
            #wp-admin-copilot-panel header {
                display: flex;
                align-items: center;
                justify-content: space-between;
                padding: 10px;
                border-bottom: 1px solid #dcdcde;
                background: #f6f7f7;
            }
            #wp-admin-copilot-panel header button {
                margin-left: 6px;
            }
            #wp-admin-copilot-log {
                height: calc(100% - 126px);
                padding: 10px;
                overflow-y: auto;
                font-size: 13px;
                line-height: 1.5;
            }
            #wp-admin-copilot-controls {
                display: flex;
                gap: 8px;
                padding: 10px;
                border-top: 1px solid #dcdcde;
            }
            #wp-admin-copilot-input {
                flex: 1;
                min-width: 0;
            }
            #wp-admin-copilot-send {
                background: #2271b1;
                border: 1px solid #2271b1;
                color: #fff;
                border-radius: 4px;
                cursor: pointer;
                padding: 0 10px;
            }
            #wp-admin-copilot-status {
                margin: 0;
                padding: 0 10px 10px;
                color: #50575e;
                font-size: 12px;
                min-height: 16px;
            }
        </style>
        <?php
    }
}

WP_Admin_Copilot::init();
