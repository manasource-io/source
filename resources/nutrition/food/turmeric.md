---
draft: false
title: Turmeric
code: FSU1
category: food
subCategory: spice
components:
  - curcumin
  - anti-inflammatory
description: >-
  Golden spice from the Curcuma longa root with potent anti-inflammatory and
  anti-cancer properties via curcumin, especially when paired with black pepper
score: 6
updatedAt: '2026-04-10'
createdAt: '2026-04-24'
associations:
  - id: cancer-risk
    delta: -4
    benefit: 4
    trust: 4
  - id: gut-health
    delta: 4
    benefit: 4
    trust: 4
  - id: inflammation
    delta: -4
    benefit: 4
    trust: 4
  - id: mental-health
    delta: 4
    benefit: 4
    trust: 4
claims:
  - id: anti-inflammatory
    label: >-
      Curcumin inhibits NF-κB and pro-inflammatory cytokines at the molecular
      level
  - id: cancer-prevention
    label: Disrupts all three phases of tumor development in laboratory models
  - id: antioxidant
    label: Reduces oxidative stress and upregulates endogenous antioxidant enzymes
  - id: digestive-health
    label: Supports bile production and has a long history of use for gut comfort
references:
  - url: 'https://pubmed.ncbi.nlm.nih.gov/19838007/'
    title: >-
      4G/5G variant of plasminogen activator inhibitor-1 gene and severe
      pregnancy-induced hypertension: subgroup analyses of variants of
      angiotensinogen and endothelial nitric oxide synthase.
    date: '2009-01-01'
  - url: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC3918523/'
    title: >-
      Recent developments in delivery, bioavailability, absorption and
      metabolism of curcumin: the golden pigment from golden spice.
    date: '2014-01-15'
  - url: 'https://examine.com/supplements/curcumin/'
    title: 'Curcumin benefits, dosage, and side effects'
    date: '2026-03-02'
pairing:
  - resource: food/black-pepper
    type: requisite
    note: >-
      Piperine in black pepper increases curcumin bioavailability by up to 20x
      by inhibiting intestinal and hepatic metabolism
  - condition: with-fat
    type: synergy
    note: >-
      Curcumin is fat-soluble; consuming with a meal containing dietary fat
      improves absorption
---
Turmeric (*Curcuma longa*) is a rhizome in the ginger family used for millennia in South Asian cuisine and traditional medicine. Its defining compound, curcumin, accounts for 2–5% of the dried spice by weight and is responsible for its vivid yellow-orange color and most of its studied health effects. Unlike the concentrated supplement form , which delivers 500–1,500 mg of isolated curcumin , culinary turmeric provides roughly 50–200 mg of curcumin per teaspoon, embedded in a broader matrix of turmerones and bisdemethoxycurcumin that may contribute synergistic effects absent from purified extracts.

## Anti-Inflammatory Mechanism {#anti-inflammatory}

Curcumin inhibits NF-κB , one of the central transcription factors governing inflammation across tissues , and downstream targets including IL-1β, IL-6, TNF-α, and COX-2. This overlaps mechanistically with NSAIDs but through a distinct pathway that does not suppress the gastric prostaglandins NSAIDs suppress, which may explain the better gastrointestinal tolerability profile. In human trials at supplemental doses, effects on inflammation markers (hs-CRP, IL-6) are measurable; at culinary doses the effects are more modest, but lifelong regular exposure through diet may still be meaningful, particularly as part of an overall anti-inflammatory eating pattern.

## Cancer Prevention {#cancer-prevention}

A comprehensive review (PMID 19838007) documented that curcumin can interfere with all three phases of carcinogenesis. During initiation, it reduces DNA adduct formation and enhances detoxification of carcinogens via NRF2 pathway induction. During promotion, it suppresses inflammatory signaling , particularly NF-κB and COX-2 , that sustains pre-malignant cell survival. During progression, it inhibits tumor angiogenesis (cutting off blood supply to growing tumors), reduces expression of metalloproteinases used for metastasis, and induces apoptosis in malignant cells via caspase-3 and -9 pathways. A key property observed in laboratory models is selectivity: curcumin preferentially induces apoptosis in malignant cells while leaving healthy cells largely unaffected , a property rarely seen in synthetic compounds. Active study continues in colorectal, breast, prostate, and pancreatic cancers.

## The Black Pepper Pairing {#bioavailability}

Standard curcumin , whether from culinary turmeric or plain supplements , has notoriously poor bioavailability. Most is not absorbed into circulation; what is absorbed is rapidly metabolized. Piperine, the alkaloid that gives black pepper its heat, resolves this by inhibiting UDP-glucuronosyltransferase and CYP3A4 , the enzymes that rapidly degrade curcumin in the gut and liver. A landmark human pharmacokinetic study (PMC3918523) showed that co-administering 20 mg of piperine with curcumin increased serum curcumin concentrations by approximately 2,000%. A pinch of black pepper , just a few grinds , provides enough piperine to produce this effect. Adding black pepper whenever turmeric is used is therefore the single most impactful step for improving its bioavailability.

## Antioxidant Activity {#antioxidant}

Curcumin scavenges reactive oxygen species and upregulates endogenous antioxidant enzymes including superoxide dismutase (SOD) and catalase. Turmeric also contains aromatic turmerones , sesquiterpene compounds with their own antioxidant and emerging neuroprotective properties.

## Culinary Use vs. Supplement

For dietary use, adding turmeric generously with black pepper to curries, soups, smoothies, or roasted vegetables is an accessible and safe practice. For therapeutic doses targeting specific conditions , joint pain, depression adjunct therapy , the concentrated supplement form with an enhanced bioavailability formulation is appropriate. See `supplement/curcumin` for clinical dosing guidance.

## Digestive Health {#digestive-health}

Supports bile production and has a long history of use for gut comfort. The evidence and practical framing for this claim are covered in the page narrative above.
