# FOWS - Foundry Battle Plan Manager

A web-based isometric map manager for coordinating legion battle plans in a foundry-themed strategy game.

## Features

### Security & Safety
- **Secure Session Management**: HttpOnly and SameSite cookies prevent XSS and CSRF attacks
- **Request Validation**: Enforces POST+JSON content type for data operations
- **Payload Validation**: Validates required data structure (buildings & legion_data)
- **Safe Concurrent Writes**: File locking (flock) prevents data corruption from simultaneous saves
- **Automatic Data Normalization**: Rounds floating-point coordinates to 2 decimal places
- **Change History**: Automatically saves timestamped backups in `history/` directory

### Admin Interface (admin.php)
- **Visual Assignment Editor**: Drag-and-drop interface for managing player assignments
- **JSON Validation**: Real-time validation with visual feedback before saving
- **Test Preview Connection**: Button to verify live preview connectivity
- **Improved Error Messages**: Clear, actionable error feedback
- **CSV Import/Export**: 
  - Export player assignments to CSV for external editing
  - Export player lists by legion
  - Import assignments from CSV files
- **Building Visual Editor**: Adjust building scale and Y-offset per building

### Map Interface (index.html)
- **Isometric Grid Display**: Interactive map with building placement
- **Player Assignment Connectors**: Visual lines connecting players to buildings
  - Improved smoothing and opacity for better readability
  - Reduced visual clutter with optimized rendering
- **Drag & Drop Assignments**: Drag players from panel to buildings
  - Toast notifications confirm successful assignments
- **Building Filter**: Filter player list by selected building
  - Highlights all players assigned to a specific building
- **Mobile-Optimized Polling**:
  - Disabled by default on mobile to reduce bandwidth
  - Temporary enable button (auto-disables after 5 minutes)
  - Smart polling with conditional requests (ETag/Last-Modified)
- **Live Preview Updates**: Real-time sync with admin interface via postMessage

### Performance Optimizations
- **Smart Autosave**: Only saves when data actually changes
- **Metadata Versioning**: Tracks version and last update timestamp
- **Conditional Polling**: Reduces unnecessary network requests
- **Visibility-Aware**: Pauses polling when page is hidden or unfocused
- **Exponential Backoff**: Adaptive retry intervals on errors

## Installation

1. Clone the repository
2. Ensure PHP 7.4+ is installed
3. Configure `config.php` with your admin password
4. Point web server to the project directory
5. Access via browser:
   - Admin interface: `admin.php`
   - Map preview: `index.html`

## Configuration

Edit `config.php`:

```php
return [
  // Plain password (for development)
  'admin_password_plain' => 'your_password_here',
  
  // Or use bcrypt hash (recommended for production)
  'admin_password_hash' => '',
  
  // Data file path
  'data_file' => __DIR__ . '/foundry_map_data.json'
];
```

## Usage

### Admin Workflow
1. Login to `admin.php` with configured password
2. Click "Open Preview" to open map in new window
3. Use "Test Preview Connection" to verify connectivity
4. Edit map data:
   - **Visual Editor**: Add/edit buildings, adjust positions
   - **JSON Editor**: Direct JSON editing with validation
   - **Legion Management**: Add/edit legions and stages
   - **Assignment Editor**: Assign players to buildings per stage
5. Changes auto-save and push to preview window

### CSV Import/Export
- **Export Assignments**: Download all player-building assignments
- **Export Players**: Download player lists by legion
- **Import**: Upload CSV to bulk-import assignments
  - Format: `Player Name, Legion ID, Stage Number, Building ID`

### Map Preview
1. Select legion and stage from controls
2. View player assignments on map
3. Drag players from panel to buildings (if admin)
4. Use filter dropdown to show only players assigned to specific buildings
5. Click "Jump" to highlight player's assignments
6. Enable temporary polling for auto-refresh (mobile)

## File Structure

```
/
├── admin.php              # Admin interface
├── index.html             # Map preview
├── save_data.php          # Save endpoint (with security)
├── config.php             # Configuration
├── foundry_map_data.json  # Main data file
├── history/               # Automatic backups (gitignored)
├── css/                   # Stylesheets
├── js/
│   ├── map.js            # Core map logic
│   ├── ui-controls.js    # UI controls
│   ├── map.mobile.js     # Mobile adaptations
│   └── mobile.js         # Mobile helpers
└── assets/               # Building images
```

## Recent Improvements (v2.0)

- ✅ Enhanced security with session hardening and request validation
- ✅ Client-side JSON validation with visual feedback
- ✅ Test preview connectivity button
- ✅ Improved error messaging throughout
- ✅ CSV import/export for assignments and players
- ✅ Toast notifications for drag-drop assignments
- ✅ Better connector smoothing and opacity
- ✅ Building filter in player panel
- ✅ Smart autosave (only on actual changes)
- ✅ Metadata versioning for change detection
- ✅ Temporary polling enable (auto-disable after 5 min)
- ✅ Automatic history/changelog
- ✅ Float normalization in coordinates

## Notes

- History files in `history/` are automatically created but gitignored
- Default password is `vexvex` - change in `config.php` for production
- Mobile polling is disabled by default to conserve bandwidth on free hosting
- All saves create timestamped backups for recovery

## License

[Specify license here]