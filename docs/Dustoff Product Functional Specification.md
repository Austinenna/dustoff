# Dustoff Product Functional Specification

This document is for frontend designers to understand the product. It describes product functions, user flows, business states, and boundaries. It does not prescribe page structure, layout, visual style, or copywriting.

## Product overview

Dustoff is a personal collection management tool. It helps users turn saved content that is rarely revisited into readable knowledge notes, or keep videos and image galleries locally for later viewing.

The current product supports Douyin collections and runs on the user’s Mac. After connecting a Douyin account and configuring the processing services, users can run processing manually or on a schedule. All results are stored locally. Speech transcription and note generation use the AI services configured by the user.

## Core workflow

1. **Initial setup**: Connect a Douyin account and configure AI services, storage locations, and processing rules.
2. **Create a baseline**: During the first run, record a set of existing collections as a reference. These historical items are not downloaded or processed automatically.
3. **Find new items**: Later runs sync new collections and continue processing existing pending items.
4. **Determine the purpose**: AI determines whether a video should become a knowledge note or be kept for viewing. Image galleries are identified by their media format. Items whose purpose cannot be determined are sent for user confirmation.
5. **Create results**: Generate a note, save a video, or save an image gallery according to the selected purpose.
6. **Review and manage**: Read, play, search, confirm, retry, or otherwise manage results and pending items.

| Processing type | System action | Result |
| --- | --- | --- |
| Knowledge note | Extract speech, transcribe it, and summarize the useful content | Knowledge note, original transcript, and formatted transcript |
| Video | Save a high-quality original-sound video for viewing | Local video file |
| Image gallery | Save the complete image set in its original order | Local image gallery |
| Needs confirmation | Pause automatic processing until the user selects a purpose | The item enters the note or video workflow after confirmation |

“Needs confirmation” is a processing state, not a result type. One collection may retain both text results and a video. Its processing state, existing results, and file availability are tracked separately.

## Functional scope

### View processing status

Users can view the total number of collections, notes, local videos, and image galleries, as well as today’s processing count, remaining pending items, items needing confirmation, and failed items.

The product also shows the latest sync time, recent results, the current task, account connection status, automatic processing status, and the next scheduled run. Each summary can lead to the relevant result or action.

### Manage collections and processing purposes

- Browse and search collection records, and filter by status such as needs confirmation, failed, saved, or historical baseline.
- View the title, author, duration or image count, source, current purpose, decision reason, processing progress, and existing results for each item.
- For eligible video items, choose **Knowledge note**, **Video**, or **Needs confirmation**. The next run uses the new purpose, while existing results are kept.
- View an AI purpose suggestion and distinguish it from the purpose that is currently applied.
- View the reason for a failed item and restore it to the pending queue for a later run.
- Open the original Douyin item, or read, play, or browse the results already created for the collection.

Historical baseline items do not enter the processing queue automatically and cannot be started by changing their purpose. Image galleries are always saved as image sets and do not use the video purpose selector.

### Read notes and transcripts

- Browse text results and distinguish items with a completed note from items that only have a transcript. Search by title or author.
- Read the AI-generated knowledge note, including its title, author, category, and generation time.
- Read the formatted transcript to verify the original wording and the complete content. Formatting does not replace or summarize the transcript.
- Open the original item, open the note in Obsidian, or open the local notes directory.

The knowledge note and full transcript are two text results from the same collection. Older items or items that only completed transcription may not have a formatted transcript; the product must show that state clearly. The original transcript remains available locally.

### Watch and manage videos

- Browse locally saved videos and search by title or author. View the cover, duration, author, and saved-media status.
- Play a video in the browser or open it in the system player. If the original format is incompatible with browser playback, generate a compatible playback copy.
- Open an associated note or transcript.
- Move a local video to the system Trash while keeping its text results and collection record.
- For eligible saved videos, start **Convert to note**.

**Convert to note behavior**: The action adds the video to the pending queue. The next manual or scheduled run uses the local video to generate a note; it does not process the model immediately and does not download the video again. The video remains playable while waiting. After the note and transcript are saved reliably and completely, the original video is moved to the system Trash. If processing fails or the source material is insufficient, the video and existing results remain. If note generation succeeds but video cleanup fails, those outcomes are recorded separately.

### Browse image galleries

- Browse and search saved image galleries, and view their title, author, image count, and total file size.
- View images in their original order, move to the previous or next image, or select a specific image.
- Open an original image, the local image folder, or the original Douyin item.

An image gallery is saved as one complete set. A partially failed set can be resumed to download missing images. Image galleries do not currently generate notes.

### Control manual and automatic processing

**Manual processing**: View pending items and the remaining daily quota, choose the maximum number of items for the run, and optionally process only existing pending items without scanning for new collections. During processing, users can view the task type and start time. A task started by the current console can be stopped; completed stages remain available.

**Automatic processing**: Set a start time, repeat interval, and whether automatic processing should be enabled after the user logs in to the computer. Enable or disable the schedule, preview upcoming run times, and view the next scheduled run.

Closing the browser does not stop background scheduled processing. Refreshing or reopening the console does not change the schedule. When the background service starts again, it attempts to restore the saved schedule. Automatic processing depends on the local runtime environment.

**Run history**: Review each processing run’s time, result summary, counts by result type, remaining pending items, and failure reasons. Detailed execution logs can be opened when needed. If scanning new collections is blocked, existing pending items may still be processed, so scan results and processing results must remain distinguishable.

### Connect the account and configure services

| Configuration area | User actions |
| --- | --- |
| Douyin account | Start official QR-code login, check whether the login is valid, view the estimated expiry, and set an advance warning period |
| AI services | Configure the endpoint, model, and key for purpose classification, speech transcription, and note generation; optionally configure transcription keywords and note-generation parameters |
| Storage locations | Set the directories for notes, original transcripts, videos, and image galleries; open the relevant local directories |
| Storage limits | View retained media, temporary cache, and available disk space; set the collection capacity, cache limit, and minimum free space |
| Processing rules | Set the daily processing limit, maximum video duration, run timeout, log retention period, and system notifications |

QR-code login is completed on the official Douyin page in local Chrome. The estimated expiry is informational; actual availability is determined by a live check. Saved model keys can be updated but are never displayed in full.

Processing configuration changes take effect from the next run. Changing a storage directory affects new results only and does not move existing files. Schedule controls are saved and enabled or disabled separately.

## Business states to preserve

| State or condition | User needs to know or do |
| --- | --- |
| Account not connected or login expired | New collections cannot be synced normally; the user can log in or run a live check |
| Baseline not created | The first run only records existing collections and does not process historical content in bulk |
| Pending or processing | Show the current purpose, completed stages, existing results, and available actions |
| Purpose needs confirmation | Explain that the purpose could not be determined automatically and allow the user to choose note or video |
| Processing completed | Show which results were created and which local files are still available |
| Processing failed or skipped | Show the reason, preserved results, and whether the item can be retried or its purpose changed |
| Quota or storage limit reached | Explain why processing stopped and show the relevant quota or storage condition |
| Empty, no search results, or read failure | Distinguish between no data, no matching items, and temporary inability to read data |

## Core rules and current boundaries

- Only one processing task runs at a time. This prevents duplicate processing and conflicting changes. Stopping a task does not undo completed results.
- Changing a purpose, restoring a failed item, and converting a video to a note update the pending queue first; the next run performs the work.
- Daily quota, maximum video duration, and available disk space jointly limit processing. One image gallery counts as one processed item.
- Ordinary retained videos and image galleries are not removed by temporary-cache cleanup. Temporary media used for note generation is cleaned up after the success conditions are met. The post-success cleanup rule for videos explicitly converted to notes is separate.
- The current scope is single-user, local operation, and newly collected Douyin content. Multi-platform support, bulk processing of historical collections, OCR, and note generation from image galleries are outside the current scope.
- The product supports reading results and opening local files. It does not currently include in-app note editing, cross-device synchronization, or multi-user collaboration.
