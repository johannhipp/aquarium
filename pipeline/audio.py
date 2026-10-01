#!/usr/bin/env python3
"""Build the per-creature audio loops in public/audio/ from openly licensed field recordings.

    python pipeline/audio.py [track-id ...]  # download sources (cached), mix, normalise, encode, write audio.json

Outputs: public/audio/<id>.mp3 plus a slim public/audio/audio.json (file, durationSec, loop) that the app
fetches, and the full credits record (layers, sources, licences, notes) in art/audio/credits.json (not served).

Every track is `LOOP_SEC` seconds of river ambience (the bed) with a few sparse accents on top. The
mix is rendered `FOLD_SEC` longer than the final length and the overshoot is cross-faded back onto the
start, so the last sample flows into the first one and the file loops without a seam (no baked-in
fades: the app ramps the gain itself). All tracks are loudness-normalised to the same integrated
loudness with ffmpeg's two-pass loudnorm and encoded as 128 kbps stereo MP3 with a LAME/Xing header,
which carries the encoder delay/padding so gapless decoders (Web Audio decodeAudioData, ffmpeg) trim it.

Sources are the 128 kbps "hq" previews that Freesound serves without an API key (the lossless
originals need a login), plus one public-domain NPS file from Wikimedia Commons.
"""
from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import requests

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / "pipeline" / "cache" / "audio"
OUT = ROOT / "public" / "audio"

SR = 44100
LOOP_SEC = 18.0  # final length of every track (small payload; the app loops it)
FOLD_SEC = 3.0  # cross-fade that closes the loop
BED_DB = -30.0  # every layer is first normalised to this RMS (dBFS), then offset by its `gain`
TARGET_LUFS = -20.0
TRUE_PEAK = -4.0  # headroom: mp3 coding overshoots the limiter target by 1-2 dB
BITRATE = "128k"

CC0 = ("CC0 1.0", "https://creativecommons.org/publicdomain/zero/1.0/")
CC_BY = ("CC BY 4.0", "https://creativecommons.org/licenses/by/4.0/")
PD_NPS = ("Public domain (US National Park Service)", "https://commons.wikimedia.org/wiki/File:Alder_Flycatchers_Yukon_River.ogg")
CC_BY_3 = ("CC BY 3.0", "https://creativecommons.org/licenses/by/3.0/")
CC_BY_NC_SA_3 = ("CC BY-NC-SA 3.0 (non-commercial, share-alike)", "https://creativecommons.org/licenses/by-nc-sa/3.0/")
PD_NPS_WORK = ("Public domain (US National Park Service work)", "https://www.nps.gov/subjects/sound/gallery.htm")


@dataclass(frozen=True)
class Source:
    key: str
    url: str  # file actually downloaded
    page: str  # human-facing page of the recording
    title: str
    author: str
    licence: tuple[str, str]
    what: str  # what this recording is and where it was made


FS = "https://cdn.freesound.org/previews"
SOURCES: dict[str, Source] = {s.key: s for s in [
    Source("parintins-night", f"{FS}/658/658081_14090125-hq.mp3",
           "https://freesound.org/people/WilliamDauricio/sounds/658081/",
           "night_on_the_river.WAV", "WilliamDauricio", CC_BY,
           "Night on the Amazon at Parintins, Amazonas, Brazil (ambisonics recording): water, frogs and insects on the main stem."),
    Source("amazon-hull", f"{FS}/871/871472_16331892-hq.mp3",
           "https://freesound.org/people/edfrederick/sounds/871472/",
           "Amazon River Cargo Boat- Water against Hull", "edfrederick", CC0,
           "Water against the bow of a slow cargo boat on the Amazon (Solimoes) between Manaus and Tabatinga, Brazil, 2002."),
    Source("ganges-varanasi-1", f"{FS}/578/578753_9034501-hq.mp3",
           "https://freesound.org/people/kevp888/sounds/578753/",
           "BR_041_India_GangesRiver.mp3", "kevp888 (Kevin Luce)", CC_BY,
           "Early morning on the Ganges from a wooden boat near Varanasi, India: wavelets, temple bells, distant voices, birds."),
    Source("ganges-varanasi-2", f"{FS}/578/578754_9034501-hq.mp3",
           "https://freesound.org/people/kevp888/sounds/578754/",
           "BR_049_India_GangesRiver.mp3", "kevp888 (Kevin Luce)", CC_BY,
           "Boats meeting on the Ganges near Varanasi, India: wavelets, birds, temple bells, voices from other boats."),
    Source("boto-hydrophone", f"{FS}/408/408555_1661766-hq.mp3",
           "https://freesound.org/people/felix.blume/sounds/408555/",
           "Amazonian Dolphins", "Felix Blume", CC0,
           "Hydrophone recording (Aquarian H2a) of Amazon river dolphins (boto, Inia geoffrensis) in the Rio Tefe, Brazil, 2017."),
    Source("yukon-whitehorse", f"{FS}/865/865260_1544275-hq.mp3",
           "https://freesound.org/people/SoundsLikeYukon/sounds/865260/",
           "Yukon River by KDCC - with drumming", "SoundsLikeYukon", CC0,
           "The Yukon River running over a rocky shallow at Whitehorse, Yukon (with faint drumming far behind the recordist), 2026."),
    Source("yukon-raven", f"{FS}/824/824995_1544275-hq.mp3",
           "https://freesound.org/people/SoundsLikeYukon/sounds/824995/",
           "Raven pair on Yukon River bank", "SoundsLikeYukon", CC0,
           "Two ravens on the bank of the Yukon River in Whitehorse."),
    Source("yukon-flycatcher", "https://upload.wikimedia.org/wikipedia/commons/e/ef/Alder_Flycatchers_Yukon_River.ogg",
           "https://commons.wikimedia.org/wiki/File:Alder_Flycatchers_Yukon_River.ogg",
           "Alder Flycatchers Yukon River", "National Park Service", PD_NPS,
           "Alder flycatchers in Yukon-Charley Rivers National Preserve, Alaska."),
    Source("volga", f"{FS}/840/840824_18249425-hq.mp3",
           "https://freesound.org/people/Agnivolok/sounds/840824/",
           "Volga River", "Agnivolok", CC0,
           "Soundscape of the Volga recorded from an upper embankment (Zoom H5Studio); place not stated, the recordist's other uploads are from Volgograd."),
    Source("victoria-falls", f"{FS}/194/194869_3311332-hq.mp3",
           "https://freesound.org/people/toadie/sounds/194869/",
           "Vic Falls.mp3", "toadie", CC0,
           "Victoria Falls on the Zambezi, Zambia/Zimbabwe: 'the smoke that thunders'."),
    Source("kafue-hippos-1", f"{FS}/194/194870_3311332-hq.mp3",
           "https://freesound.org/people/toadie/sounds/194870/",
           "hippos.mp3", "toadie", CC0,
           "A group of hippos grunting in the Kafue River, Zambia (the Zambezi's largest Zambian tributary), morning."),
    Source("kafue-hippos-2", f"{FS}/194/194871_3311332-hq.mp3",
           "https://freesound.org/people/toadie/sounds/194871/",
           "hippos 2.mp3", "toadie", CC0,
           "A group of hippos grunting in the Kafue River, Zambia, morning."),
    Source("yangtze-nanjing", f"{FS}/328/328088_2999534-hq.mp3",
           "https://freesound.org/people/gamma1/sounds/328088/",
           "Yangtze river.wav", "gamma1", CC0,
           "Waves washing the bank of the Yangtze at Nanjing, China, with swells from passing cargo boats, 2015."),
    Source("spotted-dolphin-hydrophone", f"{FS}/385/385796_4438201-hq.mp3",
           "https://freesound.org/people/geraldfiebig/sounds/385796/",
           "Atlantic Spotted Dolphins off the coast of La Gomera, Canary Islands", "geraldfiebig", CC0,
           "Hydrophone recording of a group of Atlantic spotted dolphins (Stenella frontalis) clicking and whistling off La Gomera."),
    Source("irrawaddy-magway", "https://archive.org/download/aporee_23701_27551/12031.mp3",
           "https://archive.org/details/aporee_23701_27551",
           "Region de Magway, Myanmar - BINAURAL cruise on Irrawaddy river", "Espaces Sonores // Stephane MARIN (radio aporee)", CC_BY_NC_SA_3,
           "Binaural recording on a river cruise on the Irrawaddy in Magway Region, Myanmar, March 2013; a window with only faint distant voices."),
    Source("caribbean-dolphin", f"{FS}/161/161691_1661766-hq.mp3",
           "https://freesound.org/people/felix.blume/sounds/161691/",
           "Dolphin screaming underwater in Caribbean Sea (Mexico)", "Felix Blume", CC0,
           "Hydrophone recording of a wild dolphin's whistles and pulse trains near Punta Allen, Mexico."),
    Source("elbe-hamburg-1", f"{FS}/75/75977_28867-hq.mp3",
           "https://freesound.org/people/inchadney/sounds/75977/",
           "River Elbe near Hamburg", "inchadney", CC_BY,
           "Waves lapping the Elbe shore at Ovelgoenne, Hamburg, July 2009."),
    Source("elbe-hamburg-2", f"{FS}/75/75962_28867-hq.mp3",
           "https://freesound.org/people/inchadney/sounds/75962/",
           "Elbe near Ovelgoenne", "inchadney", CC_BY,
           "Waves and ship wakes on the Elbe at Ovelgoenne, Hamburg."),
    Source("loire-tours", "https://archive.org/download/aporee_37640_43094/tourspontwilsonloire140810h20.mp3",
           "https://archive.org/details/aporee_37640_43094",
           "37000 Tours, France - Loire river", "Vincent Duseigne (radio aporee)", CC_BY_3,
           "The Loire at Pont Wilson in Tours, France, with waves from a small weir, August 2017."),
    Source("loire-finck", f"{FS}/653/653535_14042309-hq.mp3",
           "https://freesound.org/people/L.Finck/sounds/653535/",
           "River Loire.wav", "L.Finck", CC0,
           "Flowing water of the Loire with a few faint birds (binaural, place not stated)."),
    Source("columbia-dock", f"{FS}/260/260263_509379-hq.mp3",
           "https://freesound.org/people/richardemoore/sounds/260263/",
           "WavesOnTheShore.wav", "richardemoore", CC0,
           "Gentle waves lapping a boat-launch dock on the Columbia River in Portland, Oregon."),
    Source("columbia-travel", f"{FS}/178/178652_3323275-hq.mp3",
           "https://freesound.org/people/aaronhahnmedia/sounds/178652/",
           "river and travel sounds.wav", "aaronhahnmedia", CC0,
           "Beside the Columbia River between Portland and Vancouver, Washington (a window with only water)."),
    Source("mississippi-barge", f"{FS}/157/157370_1050391-hq.mp3",
           "https://freesound.org/people/kvgarlic/sounds/157370/",
           "RiverWavesLappingBargeJune22012.wav", "kvgarlic", CC0,
           "Waves lapping against a barge on the Mississippi River, June 2012."),
    Source("missouri-riffle", f"{FS}/655/655508_1661766-hq.mp3",
           "https://freesound.org/people/felix.blume/sounds/655508/",
           "River flow bubbling with a bird singing behind", "Felix Blume", CC0,
           "A small river bubbling over a riffle in Missouri state, USA, May 2013."),
    Source("borba-stream", f"{FS}/658/658073_14090125-hq.mp3",
           "https://freesound.org/people/WilliamDauricio/sounds/658073/",
           "water_running_under_the_bridge.WAV", "WilliamDauricio", CC_BY,
           "Forest stream running under a bridge in Borba, Amazonas, Brazil (a town on the lower Madeira)."),
    Source("para-igarape", f"{FS}/667/667363_7057511-hq.mp3",
           "https://freesound.org/people/jose.viana/sounds/667363/",
           "Olho d'agua em igarape, grilos e cigarras", "Jose Viana (Banco Sonoro Amazonico)", CC_BY,
           "Spring and stream (igarape) at Apeu, Castanhal, Para, Brazil, with crickets and cicadas."),
    Source("tefe-dawn", f"{FS}/510/510179_1661766-hq.mp3",
           "https://freesound.org/people/felix.blume/sounds/510179/",
           "Dawn in a small village, in the Amazonian Rainforest", "Felix Blume", CC0,
           "Dawn at Tauary on the Rio Tefe, Amazonas, Brazil: insects, frogs and light water movements made by fish."),
    Source("amazon-night-bank", f"{FS}/659/659690_14090125-hq.mp3",
           "https://freesound.org/people/WilliamDauricio/sounds/659690/",
           "frogs_insects_night.WAV", "WilliamDauricio", CC_BY,
           "A riverbank at night in Amazonas state, Brazil (river not stated): frogs and insects."),
    Source("murray-cathedral", f"{FS}/427/427878_2771755-hq.mp3",
           "https://freesound.org/people/Sassaby/sounds/427878/",
           "Flowing River Cathedral Ranges", "Sassaby", CC0,
           "A flowing stream in the Cathedral Ranges, Victoria, Australia (Goulburn-Murray catchment)."),
    Source("murray-tyntynder", f"{FS}/193/193483_1728127-hq.mp3",
           "https://freesound.org/people/kangaroovindaloo/sounds/193483/",
           "Jacinta Cain Atmos", "kangaroovindaloo", CC_BY,
           "Atmosphere beside the Murray River at Tyntynder Homestead near Swan Hill, Victoria, Australia: wind, birds, insects."),
    Source("tshopo-1", "https://upload.wikimedia.org/wikipedia/commons/6/6f/Descente_de_l%27eau_au_pont_tshopo.webm",
           "https://commons.wikimedia.org/wiki/File:Descente_de_l%27eau_au_pont_tshopo.webm",
           "Descente de l'eau au pont tshopo", "Yannick Ikombe", CC0,
           "Water rushing at the Tshopo bridge in Kisangani, DR Congo (audio track of a video), 2025."),
    Source("tshopo-2", "https://upload.wikimedia.org/wikipedia/commons/e/e2/Pont_de_la_snel_tshopo.webm",
           "https://commons.wikimedia.org/wiki/File:Pont_de_la_snel_tshopo.webm",
           "Pont de la snel tshopo", "Yannick Ikombe", CC0,
           "Water at the SNEL bridge on the Tshopo in Kisangani, DR Congo (audio track of a video), 2025."),
    Source("tshopo-3", "https://upload.wikimedia.org/wikipedia/commons/b/b3/Pont_tshopo_kisangani.webm",
           "https://commons.wikimedia.org/wiki/File:Pont_tshopo_kisangani.webm",
           "Pont tshopo kisangani", "Yannick Ikombe", CC0,
           "Water at the Tshopo bridge in Kisangani, DR Congo (audio track of a video), 2025."),
    Source("iguazu", f"{FS}/339/339795_8043-hq.mp3",
           "https://freesound.org/people/dobroide/sounds/339795/",
           "20160308_14.iguazu.waterfall.flac", "dobroide", CC_BY,
           "Iguazu Falls, Misiones, Argentina (a Parana tributary): the roar of the falls, a few distant footsteps and voices on the walkway."),
    Source("chalakudy", f"{FS}/332/332419_3288322-hq.mp3",
           "https://freesound.org/people/seventhsamurai/sounds/332419/",
           "River side ambience in India, water flowing, birds, breeze", "seventhsamurai", CC0,
           "Slow-flowing water with faint crows on the bank of the Chalakudy River, Kerala, India (phone recording)."),
    Source("nps-alligator", "https://www.nps.gov/nps-audiovideo/legacy/mp3/nri/avElement/nri-AlligatorEVER1.mp3",
           "https://www.nps.gov/subjects/sound/sounds-alligator.htm",
           "Alligator (Everglades NP)", "National Park Service", PD_NPS_WORK,
           "Growls and jaw strikes of an American alligator in Everglades National Park, Florida."),
    Source("alligator-juveniles", f"{FS}/689/689966_13113654-hq.mp3",
           "https://freesound.org/people/KevinSonger/sounds/689966/",
           "Female alligator bellow and juveniles answer, SMNWR", "Kevin Songer", CC_BY,
           "A female American alligator and her juveniles grunting in a shallow pond, St. Marks National Wildlife Refuge, Florida, 2023."),
    Source("aswan-channel", f"{FS}/736/736706_2237064-hq.mp3",
           "https://freesound.org/people/SolySombraRecordings/sounds/736706/",
           "SFX_Ext_Water_Irrigation System_Nile River_Aswan_Egypt", "SolySombraRecordings", CC_BY,
           "Water in an irrigation system fed by the Nile at Aswan, Egypt (mono, Sennheiser 8060)."),
    Source("elephantine-frogs", f"{FS}/472/472818_93137-hq.mp3",
           "https://freesound.org/people/wjoojoo/sounds/472818/",
           "elephantine_island_frogs.wav", "wjoojoo", CC_BY,
           "Frogs at night on the Nile at Elephantine Island, Aswan, Egypt."),
    Source("nile-croc-juvenile", "https://media.springernature.com/original/springer-static/esm/art%3A10.1038%2Fsrep15547/MediaObjects/41598_2015_BFsrep15547_MOESM2_ESM.wav",
           "https://www.nature.com/articles/srep15547",
           "Supplementary Audio 1: juvenile Nile crocodile calls", "Chabert, Mathevon et al. (Scientific Reports 5:15547, 2015)", CC_BY,
           "Contact calls of a juvenile Nile crocodile (Crocodylus niloticus); only the first 2.4 s are recorded calls."),
    Source("mekong-vientiane", "https://archive.org/download/aporee_39453_45100/040803VientianeMekong0615hrs.mp3",
           "https://archive.org/details/aporee_39453_45100",
           "Mekong River, Vientiane, Laos - Mekong River, early morning 1", "lastpedestrian (radio aporee)", CC_BY_3,
           "The Mekong at Vientiane, Laos, early morning: a very quiet, low-frequency recording."),
    Source("chiang-rai-stream", f"{FS}/345/345144_36188-hq.mp3",
           "https://freesound.org/people/LG/sounds/345144/",
           "20140212 - Chiang Rai mountains and river at night 01.wav", "LG", CC_BY,
           "A small stream at night in the hills of Chiang Rai province, northern Thailand (not the Mekong itself): water, frogs, insects."),
    Source("mekong-don-det", f"{FS}/752/752783_424982-hq.mp3",
           "https://freesound.org/people/hopflog/sounds/752783/",
           "DonDetLaosjungleambience", "hopflog", CC0,
           "Night insects and the distant Mekong falls at Don Det, Laos."),
]}


@dataclass(frozen=True)
class Layer:
    src: str
    kind: str  # "river" | "creature"
    role: str  # "bed" (looped to fill the track) or "accent" (played once at `at`)
    start: float = 0.0  # offset into the source, seconds
    dur: float | None = None  # accent length (None = to the end of the source)
    at: float = 0.0  # accent position in the track
    gain: float = 0.0  # dB relative to BED_DB
    fade: float = 1.5  # accent fade in/out
    af: str | None = None  # extra ffmpeg audio filter applied when decoding
    even: bool = False  # bed only: flatten slow level swells (gain riding)
    note: str = ""
    then: tuple[str, ...] = ()  # bed only: keys of more sources chained after `src` before looping


@dataclass(frozen=True)
class Track:
    id: str
    layers: list[Layer] = field(default_factory=list)
    note: str = ""


TRACKS: list[Track] = [
    Track("dourada-catfish", [
        Layer("parintins-night", "river", "bed", start=30, gain=0),
        Layer("amazon-hull", "river", "bed", start=2, gain=-11, af="lowpass=f=7000"),
    ], note="Amazon main stem: night ambience at Parintins plus water against a cargo-boat hull on the Manaus-Tabatinga run. "
            "The dourada makes no known sound, so there is no creature layer."),
    Track("ganges-river-dolphin", [
        Layer("ganges-varanasi-2", "river", "bed", start=0, gain=-2),
        Layer("ganges-varanasi-1", "river", "bed", start=0, gain=-3),
        Layer("boto-hydrophone", "creature", "accent", start=6, dur=5.5, at=4, gain=1, fade=1.2, af="highpass=f=700",
              note="Amazon river dolphin (Inia geoffrensis), the closest open hydrophone recording of a freshwater river dolphin."),
        Layer("boto-hydrophone", "creature", "accent", start=39, dur=5.5, at=11, gain=1, fade=1.2, af="highpass=f=700"),
    ], note="Ganges at Varanasi (upstream of the dolphin's Bihar stretch). No open recording of the Ganges river dolphin "
            "(Platanista gangetica) was found, so the creature layer is the Amazon river dolphin (boto, Inia geoffrensis), "
            "another obligate freshwater echolocating dolphin; its click and whistle character is similar but not identical."),
    Track("chinook-salmon", [
        Layer("yukon-whitehorse", "river", "bed", start=2, gain=0, even=True),
        Layer("yukon-raven", "river", "accent", start=0, at=4, gain=-6, fade=0.15, note="Ravens on the riverbank."),
        Layer("yukon-flycatcher", "river", "accent", start=0, at=11.5, gain=-9, fade=0.2, note="Alder flycatchers, Yukon-Charley Rivers, Alaska."),
    ], note="Upper Yukon at Whitehorse, in the chinook's Canadian spawning reaches. "
            "Salmon make no sound, so there is no creature layer; the two bird accents are riverbank ambience."),
    Track("beluga-sturgeon", [
        Layer("volga", "river", "bed", start=40, gain=0),
    ], note="Volga from an embankment (place not stated; probably Volgograd, where the recordist lives). "
            "No recording of the beluga sturgeon exists, so there is no creature layer."),
    Track("zambezi-shark", [
        Layer("victoria-falls", "river", "bed", start=0, gain=0, af="adeclick=w=55:o=75"),
        Layer("kafue-hippos-1", "river", "accent", start=0, at=4, dur=5, gain=-9, fade=1.2, note="Hippos on the Kafue, a Zambezi tributary."),
        Layer("kafue-hippos-2", "river", "accent", start=2, dur=5, at=11, gain=-9, fade=1.2),
    ], note="Zambezi at Victoria Falls (the bull shark lives far downstream in Mozambique; no open recording of the lower river was found) "
            "with hippo calls from the Kafue tributary. Bull sharks are silent, so there is no creature layer."),
    Track("yangtze-finless-porpoise", [
        Layer("yangtze-nanjing", "river", "bed", start=0, gain=0, af="highpass=f=70"),
        Layer("spotted-dolphin-hydrophone", "creature", "accent", start=62, dur=5.5, at=4, gain=-3, fade=1.2, af="highpass=f=1500,lowpass=f=14000",
              note="Proxy: click trains of Atlantic spotted dolphins (Stenella frontalis)."),
        Layer("spotted-dolphin-hydrophone", "creature", "accent", start=96, dur=5.5, at=11, gain=-3, fade=1.2, af="highpass=f=1500,lowpass=f=14000"),
    ], note="Yangtze at Nanjing, about 330 km downstream of the porpoise's Poyang/Dongting reach (no open recording of the middle Yangtze exists). "
            "The finless porpoise's own clicks are ultrasonic (about 125 kHz) and inaudible, and no open recording of any porpoise was found, "
            "so the creature layer is a stand-in: hydrophone click trains of another small toothed whale, the Atlantic spotted dolphin."),
    Track("irrawaddy-dolphin", [
        Layer("irrawaddy-magway", "river", "bed", start=85, gain=0, af="highpass=f=120"),
        Layer("caribbean-dolphin", "creature", "accent", start=6, dur=5.5, at=4, gain=-10, fade=1.2, af="highpass=f=500",
              note="Proxy: whistles and pulse trains of a wild dolphin (probably bottlenose) in the Caribbean."),
        Layer("caribbean-dolphin", "creature", "accent", start=20, dur=5.5, at=11, gain=-10, fade=1.2, af="highpass=f=500"),
    ], note="Irrawaddy near Magway (about 290 km downstream of the dolphin's Katha reach), a river-cruise recording with the engine rumble filtered out; "
            "it is the only open Irrawaddy recording found, and it is licensed non-commercial/share-alike. No open recording of the Irrawaddy dolphin "
            "(Orcaella brevirostris) exists, so the creature layer is a stand-in: whistles and pulses of a wild Caribbean dolphin."),
    Track("european-eel", [
        Layer("elbe-hamburg-1", "river", "bed", start=20, gain=0),
        Layer("elbe-hamburg-2", "river", "bed", start=5, gain=0),
    ], note="Tidal Elbe shore at Ovelgoenne, Hamburg, about 11 km from the eel's Hamburg focus. Eels make no sound, so there is no creature layer."),
    Track("atlantic-salmon", [
        Layer("loire-tours", "river", "bed", start=10, gain=0),
        Layer("loire-finck", "river", "bed", start=0, gain=-2),
    ], note="Loire at Tours (about 230 km downstream of the salmon's Allier/Nevers focus; no open recording of the upper Loire) "
            "plus a second Loire recording whose place is not stated. Salmon make no sound, so there is no creature layer."),
    Track("pacific-lamprey", [
        Layer("columbia-dock", "river", "bed", start=0, gain=0),
        Layer("columbia-travel", "river", "bed", start=40, gain=-2),
    ], note="Columbia shore between Portland and Vancouver, about 80 km downstream of Bonneville, the lamprey's focus (no clean open recording of the Gorge). "
            "Lampreys make no sound, so there is no creature layer."),
    Track("mississippi-paddlefish", [
        Layer("mississippi-barge", "river", "bed", start=100, gain=0),
        Layer("missouri-riffle", "river", "bed", start=30, gain=-6),
    ], note="Mississippi waves against a barge, with a small Missouri-state creek as texture. There is no open recording of the upper Missouri "
            "(the paddlefish's Montana/North Dakota reach), which is more than 1,500 km away. Paddlefish make no sound, so there is no creature layer."),
    Track("amazon-river-dolphin", [
        Layer("borba-stream", "river", "bed", start=20, gain=0),
        Layer("para-igarape", "river", "bed", start=30, gain=-6),
        Layer("boto-hydrophone", "creature", "accent", start=24, dur=5.5, at=4, gain=1, fade=1.2, af="highpass=f=700",
              note="Wild boto (Inia geoffrensis), recorded in the Rio Tefe, not the Madeira."),
        Layer("boto-hydrophone", "creature", "accent", start=84, dur=5.5, at=11, gain=1, fade=1.2, af="highpass=f=700"),
    ], note="No open recording of the Madeira exists. The bed is a forest stream at Borba (on the lower Madeira) plus an Amazon igarape stream in Para. "
            "The boto layer is a real hydrophone recording of the species, from the Rio Tefe about 700 km from the Madeira focus."),
    Track("amazonian-manatee", [
        Layer("tefe-dawn", "river", "bed", start=10, gain=0),
        Layer("para-igarape", "river", "bed", start=30, gain=-10),
    ], note="No open recording of the Japura exists: the bed is dawn at Tauary on the Rio Tefe (83 km from the focus, same Solimoes floodplain) with an Amazon igarape stream under it. "
            "Manatees do make squeaks, but no open recording of them (or of any manatee) was found, so there is no creature layer."),
    Track("arapaima", [
        Layer("amazon-night-bank", "river", "bed", start=60, gain=0),
        Layer("para-igarape", "river", "bed", start=30, gain=-4),
    ], note="No open recording of the Purus exists: the bed is a night riverbank in Amazonas state (river not stated) with an Amazon igarape stream under it. "
            "Juvenile arapaima make low-frequency sounds, but no open recording was found, so there is no creature layer."),
    Track("murray-cod", [
        Layer("murray-cathedral", "river", "bed", start=0, gain=0),
        Layer("murray-tyntynder", "river", "bed", start=110, gain=-9, af="highpass=f=200"),
    ], note="A fast stream in the Cathedral Ranges, Victoria (Goulburn-Murray catchment, about 170 km from the cod's focus) plus a real Murray River bank recording "
            "at Tyntynder near Swan Hill. Murray cod make no known sound, so there is no creature layer."),
    Track("goliath-tigerfish", [
        Layer("tshopo-1", "river", "bed", start=0.2, gain=0, then=("tshopo-2", "tshopo-3")),
    ], note="Rapids on the Tshopo at Kisangani, a Congo-basin river about 1,190 km from the tigerfish's Kinshasa focus (no open recording of the Congo mainstem). "
            "Tigerfish make no known sound, so there is no creature layer."),
    Track("golden-dorado", [
        Layer("iguazu", "river", "bed", start=100, gain=0, af="lowpass=f=5000"),
    ], note="Iguazu Falls, a tributary of the Parana (about 370 km from the dorado's Corrientes focus); no open recording of the Parana mainstem. "
            "Golden dorado make no known sound, so there is no creature layer."),
    Track("gharial", [
        Layer("chalakudy", "river", "bed", start=15, gain=0, af="lowpass=f=4000"),
        Layer("nps-alligator", "creature", "accent", start=17, dur=6, at=4, gain=-1, fade=0.8, af="highpass=f=60,lowpass=f=3000",
              note="Proxy: growl and jaw strikes of an American alligator (Alligator mississippiensis), a crocodilian relative."),
        Layer("alligator-juveniles", "creature", "accent", start=10, dur=6, at=11, gain=-3, fade=1.0, af="lowpass=f=1000",
              note="Proxy for hatchling grunts: juvenile American alligators answering a female."),
    ], note="No open Chambal recording exists; the bed is the Chalakudy River in Kerala, India (about 1,830 km away). No open recording of the gharial's hiss, buzz or "
            "jaw-slap exists either, so the creature layers are American alligator sounds."),
    Track("nile-crocodile", [
        Layer("aswan-channel", "river", "bed", start=12, gain=0),
        Layer("elephantine-frogs", "river", "bed", start=58, gain=-6),
        Layer("nile-croc-juvenile", "creature", "accent", start=0.55, dur=1.8, at=5, gain=0, fade=0.05, af="highpass=f=300",
              note="Real juvenile Nile crocodile contact calls (Crocodylus niloticus); adult roars and bellows have no open recording."),
        Layer("nile-croc-juvenile", "creature", "accent", start=0.55, dur=1.8, at=12.5, gain=-2, fade=0.05, af="highpass=f=300"),
    ], note="Irrigation water on the Nile at Aswan plus night frogs on Elephantine Island, Aswan, about 100 km from the crocodile's Lake Nasser focus. "
            "The creature layer is two real juvenile Nile crocodile calls; no open recording of an adult's roar or bellow was found."),
    Track("mekong-giant-catfish", [
        Layer("mekong-vientiane", "river", "bed", start=20, gain=0, af="highpass=f=60"),
        Layer("chiang-rai-stream", "river", "bed", start=40, gain=-4),
        Layer("mekong-don-det", "river", "bed", start=32, gain=-8),
    ], note="The Mekong at Vientiane (about 340 km downstream of the catfish's Chiang Khong focus) and at the Don Det falls in southern Laos, "
            "with a night stream from the Chiang Rai hills (not the Mekong) for water body. No open recording from Chiang Khong/Chiang Saen exists. "
            "The giant catfish makes no known sound, so there is no creature layer."),
]


# ---------------------------------------------------------------- helpers

def run(*cmd: str) -> subprocess.CompletedProcess[bytes]:
    return subprocess.run(cmd, check=True, capture_output=True)


def fetch(src: Source) -> Path:
    CACHE.mkdir(parents=True, exist_ok=True)
    path = CACHE / f"{src.key}{Path(src.url).suffix}"
    if path.exists() and path.stat().st_size > 10_000:
        return path
    last: Exception | None = None
    for attempt in range(4):
        try:
            r = requests.get(src.url, headers={"User-Agent": "river-globe/1.0 (audio pipeline)"}, timeout=60)
            r.raise_for_status()
            path.write_bytes(r.content)
            return path
        except requests.RequestException as e:
            last = e
            time.sleep(2 * (attempt + 1))
    raise RuntimeError(f"download failed for {src.key}: {last}")


def decode(path: Path, af: str | None = None) -> np.ndarray:
    """Decode to float32 stereo at SR, shape (n, 2)."""
    chain = ["aresample=%d" % SR] + ([af] if af else [])
    out = run("ffmpeg", "-v", "error", "-i", str(path), "-af", ",".join(chain), "-ac", "2", "-f", "f32le", "-")
    return np.frombuffer(out.stdout, dtype="<f4").reshape(-1, 2).copy()


def rms_db(x: np.ndarray) -> float:
    return 10 * np.log10(float(np.mean(x.astype(np.float64) ** 2)) + 1e-12)


def normalise(x: np.ndarray, gain_db: float) -> np.ndarray:
    return x * 10 ** ((BED_DB - rms_db(x) + gain_db) / 20)


def xfade(a: np.ndarray, b: np.ndarray, n: int) -> np.ndarray:
    """Equal-power cross-fade of the last n samples of a into the first n of b."""
    t = np.linspace(0, np.pi / 2, n, dtype=np.float32)[:, None]
    mid = a[-n:] * np.cos(t) + b[:n] * np.sin(t)
    return np.concatenate([a[:-n], mid, b[n:]])


def level(x: np.ndarray, win_s: float = 4.0, max_db: float = 9.0) -> np.ndarray:
    """Slow gain riding: pull the smoothed short-term RMS towards its median so a bed has no swells."""
    win = int(win_s * SR)
    power = np.convolve((x.astype(np.float64) ** 2).mean(axis=1), np.ones(win) / win, mode="same") + 1e-12
    db = 10 * np.log10(power)
    gain = np.clip(np.median(db) - db, -max_db, max_db)  # dB
    return x * (10 ** (gain / 20)).astype(np.float32)[:, None]


def fill(seg: np.ndarray, n: int, xf: int) -> np.ndarray:
    out = seg
    while len(out) < n:
        out = xfade(out, seg, xf)
    return out[:n]


def fold_loop(mix: np.ndarray, loop_n: int) -> np.ndarray:
    """mix is loop_n + fold_n long. Output (loop_n): the overshoot fades out while the head fades in
    over the same span, so output[-1] -> output[0] continues the signal."""
    fold_n = len(mix) - loop_n
    t = np.linspace(0, np.pi / 2, fold_n, dtype=np.float32)[:, None]
    seam = mix[loop_n:] * np.cos(t) + mix[:fold_n] * np.sin(t)
    return np.concatenate([mix[fold_n:loop_n], seam])


def render(track: Track) -> np.ndarray:
    loop_n = int(LOOP_SEC * SR)
    total = loop_n + int(FOLD_SEC * SR)
    mix = np.zeros((total, 2), dtype=np.float32)
    beds = [l for l in track.layers if l.role == "bed"]
    # beds are looped to the full length and summed; different loop periods keep layered beds from repeating in lockstep
    for layer in beds:
        raw = decode(fetch(SOURCES[layer.src]), layer.af)[int(layer.start * SR):]
        seg = normalise(level(raw) if layer.even else raw, layer.gain)
        for key_ in layer.then:  # further clips of the same place, chained with a short cross-fade
            nxt = decode(fetch(SOURCES[key_]), layer.af)
            seg = xfade(seg, normalise(level(nxt) if layer.even else nxt, layer.gain), int(1.5 * SR))
        mix += fill(seg, total, 3 * SR)
    for layer in (l for l in track.layers if l.role == "accent"):
        seg = decode(fetch(SOURCES[layer.src]), layer.af)[int(layer.start * SR):]
        if layer.dur is not None:
            seg = seg[: int(layer.dur * SR)]
        seg = normalise(seg, layer.gain)
        n = len(seg)
        f = min(int(layer.fade * SR), n // 2)
        env = np.ones(n, dtype=np.float32)
        env[:f] = np.sin(np.linspace(0, np.pi / 2, f)) ** 2
        env[n - f:] = np.cos(np.linspace(0, np.pi / 2, f)) ** 2
        a = int(layer.at * SR)
        mix[a:a + n] += seg * env[:, None]
    return fold_loop(mix, loop_n)


def encode(track_id: str, wav: np.ndarray) -> Path:
    OUT.mkdir(parents=True, exist_ok=True)
    dest = OUT / f"{track_id}.mp3"
    with tempfile.TemporaryDirectory() as tmp:
        raw = Path(tmp) / "mix.f32"
        wav.astype("<f4").tofile(raw)
        src = ["-f", "f32le", "-ar", str(SR), "-ac", "2", "-i", str(raw)]
        probe = subprocess.run(
            ["ffmpeg", "-v", "info", *src, "-af", f"loudnorm=I={TARGET_LUFS}:TP={TRUE_PEAK}:LRA=11:print_format=json", "-f", "null", "-"],
            check=True, capture_output=True, text=True)
        stats = json.loads(probe.stderr[probe.stderr.rindex("{"):probe.stderr.rindex("}") + 1])
        ln = (f"loudnorm=I={TARGET_LUFS}:TP={TRUE_PEAK}:LRA=11:linear=true:measured_I={stats['input_i']}"
              f":measured_TP={stats['input_tp']}:measured_LRA={stats['input_lra']}:measured_thresh={stats['input_thresh']}"
              f":offset={stats['target_offset']}")
        run("ffmpeg", "-v", "error", "-y", *src, "-af", ln + f",aresample={SR}", "-c:a", "libmp3lame", "-b:a", BITRATE,
            "-id3v2_version", "0", "-write_xing", "1", str(dest))
    return dest


def duration(path: Path) -> float:
    out = run("ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path))
    return round(float(out.stdout), 2)

def seam_report(path: Path) -> str:
    """Decode the mp3 (gapless, like Web Audio) and compare the end->start jump with the typical sample step."""
    x = np.frombuffer(run("ffmpeg", "-v", "error", "-i", str(path), "-ac", "1", "-f", "f32le", "-").stdout, dtype="<f4")
    step = float(np.abs(np.diff(x)).mean())
    jump = float(abs(x[0] - x[-1]))
    return f"seam jump {jump / step:.2f}x mean step, {len(x) / SR:.3f} s, peak {20 * np.log10(np.abs(x).max()):.1f} dBFS"



def manifest_entry(track: Track, mp3: Path) -> dict:
    seen: dict[tuple[str, str], dict] = {}
    for layer in track.layers:
        for key_ in (layer.src, *layer.then):
            src = SOURCES[key_]
            key = (layer.kind, src.key)
            if key in seen:
                continue
            note = src.what if not layer.note or layer.note == src.what else f"{src.what} {layer.note}"
            seen[key] = {
                "kind": layer.kind,
                "title": src.title,
                "source": src.page,
                "author": src.author,
                "license": src.licence[0],
                "licenseUrl": src.licence[1],
                "note": note,
            }
    return {
        "file": f"audio/{track.id}.mp3",
        "durationSec": duration(mp3),
        "loop": True,
        "note": track.note,
        "layers": list(seen.values()),
    }


def main() -> None:
    only = set(sys.argv[1:])
    served_path = OUT / "audio.json"  # what the app fetches: file, durationSec, loop
    credits_path = ROOT / "art" / "audio" / "credits.json"  # full record (layers, licences, notes); not served
    old = json.loads(credits_path.read_text()) if only and credits_path.exists() else {}
    manifest: dict[str, dict] = {}
    for track in TRACKS:
        if only and track.id not in only and track.id in old:
            manifest[track.id] = old[track.id]
            continue
        print(f"== {track.id}")
        mp3 = encode(track.id, render(track))
        manifest[track.id] = manifest_entry(track, mp3)
        print(f"   {mp3.relative_to(ROOT)}  {manifest[track.id]['durationSec']} s  {mp3.stat().st_size // 1000} kB  {seam_report(mp3)}")
    credits_path.parent.mkdir(parents=True, exist_ok=True)
    credits_path.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n")
    slim = {tid: {k: e[k] for k in ("file", "durationSec", "loop")} for tid, e in manifest.items()}
    served_path.write_text(json.dumps(slim, indent=2) + "\n")
    print("wrote", served_path.relative_to(ROOT), "and", credits_path.relative_to(ROOT))


if __name__ == "__main__":
    main()
