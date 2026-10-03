# Dustoff Product Function Overview

Dustoff is a local tool that organizes a user’s Douyin collections. It turns selected videos into knowledge notes, saves videos for later viewing, and saves image galleries locally.

## Main workflow

1. Connect a Douyin account.
2. Sync new collections.
3. Classify each item as a knowledge note, saved video, or image gallery.
4. Process the item according to its type.
5. Review and manage the saved results.

## Main functions

### Collection management

- Browse all synced collections.
- Search by title or author.
- Filter by processing type and status.
- View collection details, processing results, and errors.
- Change the processing type for eligible videos.
- Retry failed items.
- Open the original Douyin content.

### Knowledge notes

- Convert video speech into text.
- Generate an AI-written knowledge note from the transcript.
- Read the knowledge note and the complete formatted transcript.
- Open the note in Obsidian or open its local file.

### Saved videos

- Save high-quality videos locally.
- Browse and search saved videos.
- Play videos in the browser or with the system player.
- Generate a compatible playback copy when needed.
- Delete a saved video while keeping its collection record and text results.
- Queue a saved video for conversion into a knowledge note.

### Image galleries

- Save complete image galleries in their original order.
- Browse galleries and search by title or author.
- View images one by one or select a specific image.
- Open the original image, local folder, or Douyin content.

### Manual and scheduled processing

- Start a processing run manually.
- Choose how many items to process.
- Continue existing pending items without scanning for new collections.
- Set a start time and repeat interval for automatic processing.
- Enable or disable automatic processing.
- View the next scheduled run and processing history.

### Account and service settings

- Log in to Douyin through the official QR-code flow.
- Check the current login status.
- Configure AI services for classification, transcription, and note generation.
- Configure storage locations for notes, transcripts, videos, and galleries.
- Set daily processing limits, storage limits, video duration limits, and notifications.

## Result types

| Type | Result |
| --- | --- |
| Knowledge note | AI-generated note and formatted transcript |
| Video | Local video file |
| Image gallery | Local image set |
